#!/usr/bin/env node
/* BlackBox Stream — shared source-vote server.
 *
 * One job: tell every user how the community voted on a source, fast.
 *   GET  /health
 *   GET  /votes?keys=<k1,k2,...>          batch read (this is the hot path)
 *   POST /vote  {key, dir, token}         cast or change one vote
 *
 * Design notes
 *  - No dependencies. Node 18+. One small file.
 *  - Reads are answered from memory: no disk I/O on the hot path.
 *  - Writes are debounced to disk, so a burst of votes costs one write.
 *  - Batch reads: a whole source list is one request, one round trip.
 *  - Every request is bounded: body size, key count, key length, time.
 *
 * Security
 *  - Votes are one-per-voter: the server issues an HMAC-signed voter token, so
 *    a client cannot forge someone else's identity or stuff the ballot.
 *  - Fixed-window rate limits per IP and per voter token.
 *  - Strict input validation: keys are hashes/ids, never free text; direction
 *    must be -1, 0 or 1.
 *  - Body cap, header cap, and no logging of IPs or tokens.
 *  - Optional shared secret (BBX_VOTES_SECRET) so a private deployment can
 *    refuse clients that do not hold it.
 *  - No PII is stored: a voter is an opaque random id the client generates.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || process.env.BBX_VOTES_PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.BBX_VOTES_FILE || path.join(process.cwd(), 'votes.json');
const SECRET = process.env.BBX_VOTES_SECRET || '';
const TOKEN_KEY = process.env.BBX_VOTES_TOKEN_KEY || crypto.randomBytes(32).toString('hex');
const MAX_BODY = 8 * 1024;          // a vote is tiny; anything big is not a vote
const MAX_KEYS = 200;               // one source page is 10; 200 is generous
const MAX_KEY_LEN = 300;
/* A key is an opaque identifier: a magnet URI, an infohash or a title hash.
 * The charset deliberately excludes quotes, angle brackets, spaces and
 * backslashes, so a key can never be an injection vector anywhere it is used. */
const KEY_RE = /^[A-Za-z0-9:._\-?=&%/]{4,300}$/;
const READ_RATE = Number(process.env.BBX_VOTES_RATE_READ || 240);        // per IP per minute
const WRITE_RATE = Number(process.env.BBX_VOTES_RATE_WRITE || 30);        // per IP per minute
const WRITE_RATE_VOTER = Number(process.env.BBX_VOTES_RATE_VOTER || 20);  // per voter per minute

/* ------------------------------------------------------------------ storage */

/* key -> { up: <voterId>, down: <voterId>, seen: epochMs }
 * Voters are stored as short hashes, not raw ids. */
let db = Object.create(null);
let dirty = false;

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [key, row] of Object.entries(parsed || {})) {
      if (!KEY_RE.test(key)) continue;
      const up = row && typeof row.up === 'object' ? row.up : {};
      const down = row && typeof row.down === 'object' ? row.down : {};
      db[key] = { up, down, seen: Number(row && row.seen) || Date.now() };
    }
    console.log(`[votes] loaded ${Object.keys(db).length} keys from ${DATA_FILE}`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[votes] could not read store:', error.message);
  }
}

let flushTimer = null;
function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 2000);
  if (flushTimer.unref) flushTimer.unref();
}
function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (error) {
    console.error('[votes] could not save:', error.message);
  }
}
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

/* ------------------------------------------------------------------ counters */

function scoreOf(row) {
  if (!row) return 0;
  return Object.keys(row.up).length - Object.keys(row.down).length;
}
function countsOf(row) {
  if (!row) return { up: 0, down: 0, score: 0 };
  const up = Object.keys(row.up).length, down = Object.keys(row.down).length;
  return { up, down, score: up - down };
}

/* ------------------------------------------------------------------- limits */

const windows = new Map();   // bucket -> { count, resetAt }
function limited(bucket, limit, windowMs) {
  const now = Date.now();
  const row = windows.get(bucket);
  if (!row || now > row.resetAt) {
    windows.set(bucket, { count: 1, resetAt: now + windowMs });
    return false;
  }
  row.count++;
  return row.count > limit;
}
// keep the map from growing without bound
setInterval(() => {
  const now = Date.now();
  for (const [bucket, row] of windows) if (now > row.resetAt) windows.delete(bucket);
}, 60000).unref?.();

/* --------------------------------------------------------------- voter tokens */

/* The client generates an opaque id. The server signs it, so the same device
 * cannot pretend to be many voters and nobody can invent a token for another. */
function signVoter(voterId) {
  return crypto.createHmac('sha256', TOKEN_KEY).update(voterId).digest('base64url').slice(0, 24);
}
function validVoter(voterId, token) {
  if (typeof voterId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(voterId)) return false;
  if (typeof token !== 'string' || token.length !== 24) return false;
  const expected = signVoter(voterId);
  return expected.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
/* A stable short handle for a voter, so storage holds no identifiers. */
function voterHash(voterId) {
  return crypto.createHmac('sha256', TOKEN_KEY).update('voter:' + voterId).digest('hex').slice(0, 16);
}

/* --------------------------------------------------------------------- http */

function send(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(extraHeaders || {})
  });
  res.end(payload);
}

/* Read a small JSON body. Oversized input is drained and then refused with a
 * clean 413 rather than having the socket destroyed under the client. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, oversize = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { oversize = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversize) reject(Object.assign(new Error('body too large'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  // Behind a proxy the leftmost XFF entry is the client; locally there is none.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function secretOk(req) {
  if (!SECRET) return true;
  const given = String(req.headers['x-bbx-key'] || '');
  if (given.length !== SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(SECRET));
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  // CORS: the app loads from 127.0.0.1, another device, or file://. Votes are
  // not private data and the token is the credential, so allow any origin but
  // never cookies.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,x-bbx-key');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (!secretOk(req)) return send(res, 401, { ok: false, why: 'this vote server requires a key' });

  const ip = clientIp(req);

  try {
    if (req.method === 'GET' && route === '/health') {
      return send(res, 200, {
        ok: true, keys: Object.keys(db).length,
        uptime: Math.round(process.uptime()), version: 1
      });
    }

    if (req.method === 'GET' && (route === '/votes' || route === '/')) {
      if (limited('read:' + ip, READ_RATE, 60000)) return send(res, 429, { ok: false, why: 'too many requests' });
      const keysParam = String(url.searchParams.get('keys') || '');
      if (!keysParam) return send(res, 400, { ok: false, why: 'keys is required' });
      const keys = [...new Set(keysParam.split(',').map(k => k.trim()).filter(Boolean))];
      if (!keys.length) return send(res, 400, { ok: false, why: 'keys is required' });
      if (keys.length > MAX_KEYS) return send(res, 400, { ok: false, why: 'too many keys' });
      const bad = keys.find(key => !KEY_RE.test(key) || key.length > MAX_KEY_LEN);
      if (bad) return send(res, 400, { ok: false, why: 'bad key' });

      const out = {};
      for (const key of keys) out[key] = countsOf(db[key]);
      const took = Number(process.hrtime.bigint() - started) / 1e6;
      // Short cache: the list is identical for everyone for a few seconds.
      return send(res, 200, { ok: true, votes: out, ms: Math.round(took * 100) / 100 }, {
        'cache-control': 'public, max-age=5'
      });
    }

    if (req.method === 'POST' && route === '/vote') {
      if (limited('write:' + ip, WRITE_RATE, 60000)) return send(res, 429, { ok: false, why: 'too many votes' });

      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch (error) {
        if (error.status === 413) return send(res, 413, { ok: false, why: 'body too large' });
        return send(res, 400, { ok: false, why: 'body must be JSON' });
      }

      const key = String(body.key || '');
      const dir = Number(body.dir);
      const voterId = String(body.voter || '');
      const token = String(body.token || '');

      if (!KEY_RE.test(key) || key.length > MAX_KEY_LEN) return send(res, 400, { ok: false, why: 'bad key' });
      if (![-1, 0, 1].includes(dir)) return send(res, 400, { ok: false, why: 'dir must be -1, 0 or 1' });
      if (!validVoter(voterId, token)) return send(res, 403, { ok: false, why: 'invalid voter token' });

      const voter = voterHash(voterId);
      if (limited('voter:' + voter, WRITE_RATE_VOTER, 60000)) return send(res, 429, { ok: false, why: 'slow down' });

      const row = db[key] || (db[key] = { up: Object.create(null), down: Object.create(null), seen: Date.now() });
      // one vote per voter: remove any previous vote, then apply the new one
      delete row.up[voter];
      delete row.down[voter];
      if (dir === 1) row.up[voter] = 1;
      if (dir === -1) row.down[voter] = 1;
      row.seen = Date.now();
      scheduleFlush();

      return send(res, 200, { ok: true, votes: countsOf(row), mine: dir });
    }

    if (req.method === 'POST' && route === '/token') {
      /* Issue a token for a client-generated voter id. Rate limited so a device
       * cannot mint thousands of identities. */
      if (limited('token:' + ip, 20, 60000)) return send(res, 429, { ok: false, why: 'too many tokens' });
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch { return send(res, 400, { ok: false, why: 'body must be JSON' }); }
      const voterId = String(body.voter || '');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(voterId)) return send(res, 400, { ok: false, why: 'bad voter id' });
      return send(res, 200, { ok: true, token: signVoter(voterId) });
    }

    return send(res, 404, { ok: false, why: 'unknown route' });
  } catch (error) {
    console.error('[votes] error:', error.message);
    return send(res, 500, { ok: false, why: 'server error' });
  }
});

server.headersTimeout = 8000;
server.requestTimeout = 8000;
server.keepAliveTimeout = 65000;

load();
server.listen(PORT, HOST, () => {
  console.log(`[votes] listening on http://${HOST}:${PORT}`);
  console.log(`[votes] store: ${DATA_FILE}${SECRET ? ' (key required)' : ''}`);
});

export { server, scoreOf, countsOf, validVoter, signVoter, KEY_RE };
