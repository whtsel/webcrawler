#!/usr/bin/env node
/* End-to-end smoke test for the BlackBox Stream vote server.
 *
 * Starts the real server as a child process on a free port and drives its
 * HTTP surface the way the app does: health, tokens, votes, batch reads.
 * Also checks the security promises the app depends on (forged tokens,
 * oversized bodies, bad keys) and that votes survive a restart.
 *
 * No dependencies. Node 18+.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'bbx-vote-server.mjs');

const VOTER_A = 'device-aaaaaaaa1111';
const VOTER_B = 'device-bbbbbbbb2222';
const KEY_1 = 'btih:0123456789abcdef0123456789abcdef01234567';
const KEY_2 = 'magnet:?xt=urn:btih:AAAABBBBCCCCDDDDEEEEFFFF0000111122223333&dn=Example.Movie.2024.1080p';

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  (${detail})`}`);
  }
}

function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port, dataFile) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BBX_VOTES_FILE: dataFile,
      BBX_VOTES_TOKEN_KEY: 'smoke-test-fixed-token-key',
      BBX_VOTES_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', d => log.push(String(d).trim()));
  child.stderr.on('data', d => log.push(String(d).trim()));
  return { child, log };
}

async function waitForHealth(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

const workDir = mkdtempSync(path.join(tmpdir(), 'bbx-votes-'));
const dataFile = path.join(workDir, 'votes.json');
const watchdog = setTimeout(() => {
  console.error('FAIL  watchdog: test run exceeded 90s');
  process.exit(1);
}, 90000);

let base;
let running;
let port;

async function req(method, route, options = {}) {
  const { body, headers = {} } = options;
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const token = async voter => (await req('POST', '/token', { body: { voter } })).json.token;
const vote = (key, dir, voter, tok) => req('POST', '/vote', { body: { key, dir, voter, token: tok } });

try {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  running = startServer(port, dataFile);

  console.log(`\nBlackBox Stream vote server — smoke test (port ${port})\n`);

  const healthy = await waitForHealth(base);
  if (!healthy) {
    console.error('FAIL  server never answered /health');
    console.error(running.log.join('\n'));
    process.exit(1);
  }

  /* ---------------------------------------------------------------- health */
  let res = await req('GET', '/health');
  equal('GET /health -> 200', res.status, 200);
  equal('/health ok:true', res.json.ok, true);
  equal('/health keys:0 on a fresh store', res.json.keys, 0);
  equal('/health version:1', res.json.version, 1);
  check('/health reports uptime', typeof res.json.uptime === 'number');
  check('/health is JSON', String(res.headers.get('content-type')).includes('application/json'));
  equal('nosniff header present', res.headers.get('x-content-type-options'), 'nosniff');
  equal('no-referrer header present', res.headers.get('referrer-policy'), 'no-referrer');
  equal('CORS allows the app origin', res.headers.get('access-control-allow-origin'), '*');

  res = await req('OPTIONS', '/vote');
  equal('OPTIONS /vote -> 204 preflight', res.status, 204);

  /* ---------------------------------------------------------------- tokens */
  res = await req('POST', '/token', { body: { voter: VOTER_A } });
  equal('POST /token -> 200', res.status, 200);
  const tokenA = res.json.token;
  equal('token is 24 chars (server-signed)', String(tokenA).length, 24);
  const tokenB = await token(VOTER_B);
  check('a second device gets its own token', typeof tokenB === 'string' && tokenB !== tokenA);

  res = await req('POST', '/token', { body: { voter: 'short' } });
  equal('token for a too-short voter id -> 400', res.status, 400);

  /* ----------------------------------------------------------------- votes */
  res = await vote(KEY_1, 1, VOTER_A, tokenA);
  equal('first upvote -> 200', res.status, 200);
  equal('vote count: up 1', res.json.votes.up, 1);
  equal('vote count: down 0', res.json.votes.down, 0);
  equal('score is 1', res.json.votes.score, 1);
  equal('server echoes my direction', res.json.mine, 1);

  res = await req('GET', `/votes?keys=${encodeURIComponent(KEY_1)}`);
  equal('GET /votes -> 200', res.status, 200);
  equal('batch read sees the vote', res.json.votes[KEY_1].score, 1);

  res = await vote(KEY_1, 1, VOTER_A, tokenA);
  equal('same device voting again does not stack', res.json.votes.up, 1);

  res = await vote(KEY_1, -1, VOTER_A, tokenA);
  equal('changing to a downvote moves the vote', res.json.votes.down, 1);
  equal('downvote leaves no upvote behind', res.json.votes.up, 0);
  equal('score after downvote is -1', res.json.votes.score, -1);

  res = await vote(KEY_1, 1, VOTER_B, tokenB);
  equal('second device is counted separately', res.json.votes.up, 1);
  equal('two devices: one up, one down', res.json.votes.score, 0);

  res = await vote(KEY_1, 0, VOTER_A, tokenA);
  equal('dir 0 clears this device\'s own vote', res.json.votes.down, 0);
  equal('the other device keeps its vote', res.json.votes.up, 1);

  res = await vote(KEY_1, 1, VOTER_A, tokenA);
  equal('both devices recommending -> score 2', res.json.votes.score, 2);

  res = await vote(KEY_2, 1, VOTER_A, tokenA);
  equal('votes are per source key', res.json.votes.score, 1);

  res = await req('GET', `/votes?keys=${encodeURIComponent(KEY_1)},${encodeURIComponent(KEY_2)}`);
  equal('one batch read serves a whole list', Object.keys(res.json.votes).length, 2);
  equal('first key keeps its score', res.json.votes[KEY_1].score, 2);
  equal('second key keeps its score', res.json.votes[KEY_2].score, 1);
  check('batch read reports its own timing', typeof res.json.ms === 'number');

  /* -------------------------------------------------------------- security */
  res = await vote(KEY_1, 1, VOTER_A, 'a'.repeat(24));
  equal('forged token -> 403', res.status, 403);

  res = await vote(KEY_1, 1, VOTER_B, tokenA);
  equal('another device\'s token -> 403', res.status, 403);

  res = await vote(KEY_1, 1, VOTER_A, '');
  equal('missing token -> 403', res.status, 403);

  res = await vote(KEY_1, 5, VOTER_A, tokenA);
  equal('dir must be -1|0|1 -> 400', res.status, 400);

  res = await vote('has space in it', 1, VOTER_A, tokenA);
  equal('free text as a key -> 400', res.status, 400);

  /* The key cap is 300 chars inclusive, so this must be longer than that. */
  res = await vote(`btih:${'a'.repeat(400)}`, 1, VOTER_A, tokenA);
  equal('over-long key -> 400', res.status, 400);

  res = await req('GET', '/votes');
  equal('GET /votes without keys -> 400', res.status, 400);

  res = await req('GET', `/votes?keys=${Array.from({ length: 201 }, (_, i) => `btih:${String(i).padStart(4, '0')}`).join(',')}`);
  equal('more than 200 keys -> 400', res.status, 400);

  res = await req('POST', '/vote', { body: '{not json' });
  equal('invalid JSON body -> 400', res.status, 400);

  res = await req('POST', '/vote', { body: { key: KEY_1, dir: 1, voter: VOTER_A, token: tokenA, pad: 'x'.repeat(9000) } });
  equal('body over 8 KB -> 413 (not a dropped socket)', res.status, 413);

  res = await req('GET', '/does-not-exist');
  equal('unknown route -> 404', res.status, 404);

  /* 100 keys in one read is the app's worst case for a long list. */
  const manyKeys = Array.from({ length: 100 }, (_, i) => `btih:${String(i).padStart(40, '0')}`);
  const started = Date.now();
  res = await req('GET', `/votes?keys=${manyKeys.join(',')}`);
  const elapsed = Date.now() - started;
  equal('100-key batch read -> 200', res.status, 200);
  check(`100-key batch read is fast (${elapsed} ms, budget 1000 ms)`, elapsed < 1000);

  res = await req('GET', '/health');
  equal('/health counts the two stored sources', res.json.keys, 2);

  /* ----------------------------------------------------------- persistence */
  await stopServer(running.child);
  check('store file written on shutdown', existsSync(dataFile));

  const rawStore = readFileSync(dataFile, 'utf8');
  const store = JSON.parse(rawStore);
  equal('store holds both keys', Object.keys(store).length, 2);
  equal('store keeps the score for key 1', Object.keys(store[KEY_1].up).length, 2);
  check('voters are stored as 16-char hashes', Object.keys(store[KEY_1].up).every(v => /^[0-9a-f]{16}$/.test(v)));
  check('raw device ids are never stored', !rawStore.includes(VOTER_A) && !rawStore.includes(VOTER_B));

  running = startServer(port, dataFile);
  base = `http://127.0.0.1:${port}`;
  if (!await waitForHealth(base)) {
    console.error('FAIL  server did not restart');
    console.error(running.log.join('\n'));
    process.exit(1);
  }
  res = await req('GET', `/votes?keys=${encodeURIComponent(KEY_1)},${encodeURIComponent(KEY_2)}`);
  equal('votes survive a restart (key 1)', res.json.votes[KEY_1].score, 2);
  equal('votes survive a restart (key 2)', res.json.votes[KEY_2].score, 1);
  res = await req('GET', '/health');
  equal('restart reloads the store from disk', res.json.keys, 2);

  /* The same device still holds a valid vote after a restart (fixed token key). */
  res = await vote(KEY_1, 1, VOTER_A, tokenA);
  equal('fixed token key survives restart -> 200', res.status, 200);
  equal('re-voting after restart does not double count', res.json.votes.up, 2);
} catch (error) {
  fail++;
  console.error(`\nFAIL  unexpected error: ${error && error.stack || error}`);
} finally {
  clearTimeout(watchdog);
  if (running && running.child) await stopServer(running.child);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
