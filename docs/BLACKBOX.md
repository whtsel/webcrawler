# BlackBox Stream — what this project is

Everything learned about the app, so a new session (or a new person) does not
have to rediscover it. Sources: the Drive handoff documents
(`BBX-SERVER-HANDOFF-v75.md`, `BBX-SERVER-HANDOFF.md`,
`BBX-VOTE-SERVER-README.md`) and direct inspection of `bbx-vote-server.mjs`,
which is verified byte-identical here.

---

## 1. The app in one paragraph

**BlackBox Stream** is a Windows desktop app that shows a list of movie torrent
sources. Pressing ▶ Play starts the movie almost immediately. Viewers vote each
source up or down, and the link with the most votes gets a **★ Recommended**
badge and sorts to the top of the list, so the next person takes the link that
already worked. Those votes are shared between all users through a small
standalone Node server — that server is the only thing this repository runs.

- App version: **v75**
- Source tag: `v75-vote-needs-download`
- Client: `inst-src/web/` (HTML/JS inside the installer, WebView2)
- Engine: `blackbox-core.exe`, `blackbox-local-share.exe` — **untouched, byte-identical**
- Vote server: `bbx-vote-server.mjs` — one file, no dependencies, Node 18+

## 2. Release identity (trust hashes, not file names)

| | |
|---|---|
| Setup | `BlackBoxStream-v75-Setup.exe` — 9,279,503 bytes — sha256 `b878906ea3b2306a4ff90a0460237cb8e25ddcaad2af6733062a20491e9ec525` |
| Source | `BlackBoxStream-v75-SOURCE.zip` — 29,379,110 bytes — sha256 `1a876f326d5f5e601cdfb547d8921bce840fa26a6d073ef32d8a688d79f9a3fb` |
| Server | `bbx-vote-server.mjs` — 12,491 bytes — sha256 `983f99b2f0e5919d5aaddd614dbadfa6bbdb2b382a1e722c0d48a3aae08f9ace` |
| Engines | core `8b04b695…`, local-share `f3c5f0c1…` |

`test/verify-source.mjs` fails the build if the server file in this repo ever
stops matching that hash. That is deliberate: the file is shipped, not edited.

## 3. The v75 rule — a vote requires a download

A vote means *"this link gave me the file"*, so voting is locked per link until
that link's download has **finished in the app**.

| situation | can you vote? |
|---|---|
| never downloaded this source | **no** — greyed chip, click explains why |
| download started, still running | **no** — tooltip shows the % |
| download finished (recorded) | **yes** |
| a live torrent whose stats read finished / 100% | **yes**, recorded at once |
| a different source, even for the same film | **no** |
| same infohash in a different case/spelling | **yes** — one record per `btih:<lowercase>` |
| taking back your own existing vote | **yes** — withdrawing a claim needs no download |

- Playing or streaming alone never unlocks voting: a stream does not prove the
  bytes arrived.
- The record is local only, `localStorage['bbx.downloads.v75']`, one entry per
  infohash. It is never sent to the server.
- Locked chips are never hidden and never fail silently: greyed with a lock
  glyph, a tooltip, and a toast explaining the reason.
- The check is pure local state — no network, no manifest wait — so opening a
  film stays at 0.07 s.
- Implementation: `inst-src/web/vote-gate-v75.js`, loaded as the last script on
  the page. It wraps `bbxVotesV74.vote` and `sourceCardV70`, so the rule holds
  even if something calls `vote()` directly.

## 4. What is verified (per the handoff, not assumed)

- Play starts a movie in **0.07 s warm / ~2.8 s cold** (previously 0.61 s / 38.9 s). No manifest wait, no progress bar.
- Votes are one per person, per link, and survive a restart.
- ★ Recommended badge and vote-first sorting in the source list.
- Cross-device sync verified with three simulated devices.
- Sync cannot slow a click: with the server up a click still resolved in 0.07 s; with a dead server the vote still applied in ~1 ms.
- Security: HMAC-signed voter tokens (forged votes → 403), rate limits, strict key validation, 8 KB body cap, no personal data stored.
- 90 automated checks pass in the app source: 30 server, 12 sync, 14 vote logic, 13 DOM, 21 download-gate.

Re-verified in this repository (`npm test`, 59 checks) against the real server
file: health, tokens, vote maths, one-vote-per-device, direction changes,
batch reads, forged/mismatched tokens → 403, bad keys/dirs → 400, oversized
body → 413, unknown route → 404, 100-key batch read ≈ 2–5 ms, and votes
surviving a restart with voters stored only as 16-char hashes.

## 5. Architecture

```
Windows desktop app (WebView2)
├── inst-src/web/index.html      page + window.BBX_VOTES_SERVER (the one line)
├── inst-src/web/app.js          UI, source list, player
├── inst-src/web/vote-gate-v75.js  the download gate (last script)
├── blackbox-core.exe            engine — never modified
├── blackbox-local-share.exe     engine — never modified
└── installer/                   NSIS build (wine) → BlackBoxStream-v75-Setup.exe
                    │
                    │ HTTPS, background only, 2.5 s ceiling, 30 s cache
                    ▼
        bbx-vote-server.mjs  (this repo)
        one JSON file, no database
```

The app is served over plain HTTP from `127.0.0.1`, so the public vote endpoint
**must be HTTPS** — otherwise browsers block the call as mixed content.

## 6. Server API

| Method | Path | Body / query | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, keys, uptime, version }` |
| `GET` | `/votes` | `?keys=k1,k2,…` (max 200) | `{ ok, votes: { key: { up, down, score } }, ms }` |
| `POST` | `/vote` | `{ key, dir, voter, token }` | `{ ok, votes, mine }` |
| `POST` | `/token` | `{ voter }` | `{ ok, token }` |

`dir` is `1` (recommend), `-1` (did not work) or `0` (clear). `key` is the
source identity: a `magnet:…` URI, an infohash, or a title hash. Keys must match
`^[A-Za-z0-9:._\-?=&%/]{4,300}$` — no quotes, brackets, spaces or backslashes.

`GET /` is an alias for `/votes`.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port (`BBX_VOTES_PORT` also honoured) |
| `HOST` | `0.0.0.0` | bind address |
| `BBX_VOTES_FILE` | `./votes.json` | where votes are stored |
| `BBX_VOTES_SECRET` | _(empty)_ | optional shared key; clients must send `x-bbx-key` |
| `BBX_VOTES_TOKEN_KEY` | random per boot | HMAC key for voter tokens |
| `BBX_VOTES_RATE_READ` | `240` | reads per IP per minute |
| `BBX_VOTES_RATE_WRITE` | `30` | votes per IP per minute |
| `BBX_VOTES_RATE_VOTER` | `20` | votes per voter per minute |

Set `BBX_VOTES_TOKEN_KEY` to a fixed value so client tokens stay valid across
restarts. Without it, each client fetches one new token after a restart
(harmless, just noisier).

### Security model

- **One vote per person.** The client generates a random device id; the server
  signs it with an HMAC and only accepts votes carrying a valid signature. A
  client cannot vote as another device.
- **No personal data.** The store keeps only a 16-character hash of the device
  id, never the id itself. No IPs, keys or tokens are logged.
- **Rate limits** per IP and per voter; tokens issued under their own limit.
- **Bounded requests:** 8 KB body cap (413), 8 s request timeout, 200-key cap.
- **Strict validation:** keys are opaque ids, `dir` must be exactly -1/0/1.
- **CORS** open without credentials — the app runs from `127.0.0.1` or `file://`.

## 7. Version history (as evidenced in Drive)

Newest first; older builds remain in Drive and **must not be shipped**.

| Version | Notes |
|---|---|
| **v75** | **current** — vote requires a finished download |
| v74 | shared votes, no download gate |
| v59, v34, v14/v15 | older Windows builds (folders/zips) |
| v1 Desktop, Android 1.2 | early branches |
| BlackBoxV2-Quarantine-Source, `blackbox-v2-*` folders | quarantine / v2 experiments |

Do not use these Drive IDs: `1lZVjy5F…` / `1qPiRC_X…` (v74), `1aWHJ_5Z…`,
`1Lr6t3ic…`, `1eqXLjVn…`, and **never** `1SSsoBPLC…` / `1Wf6xW-g…` (contain an
engine-swap fallback).

## 8. Drive file IDs

Named lookups are ambiguous — many builds share a name.

| File | Drive ID |
|---|---|
| `BBX-SERVER-HANDOFF.md` (short, start here) | `1jIVkP4F7gXtwKmlerT10oHSSRevUoi6W` |
| `BBX-SERVER-HANDOFF-v75.md` (all 11 sections) | `1udvAU0cZ3j5ZzlVQQzzt3Cl4xuUiWprx` |
| `BBX-SERVER-HANDOFF-FULL.md` | `1eR7-SU4JE9Ge3Rh4Nptk5I2E_R4DDP-k` |
| `bbx-vote-server.mjs` | `1iePj17PP5XuTGTRW4fhzG46cdAhWhmLY` |
| `BBX-VOTE-SERVER-README.md` | `1aXU3-c7AU_p-EruCN2hH_Tb3-t7xXimi` |
| `BlackBoxStream-v75-Setup.exe` | `1gm4i_QOFHZWJ2y9ZE6h1Wicc_xCdmxwP` |
| `BlackBoxStream-v75-SOURCE.zip` | `1bfYsLrtAeMFkQOVFwRUZQvxBtno6KdBn` |

## 9. Rules this project follows

1. **Never modify, re-sign or swap the engine binaries.** They stay
   byte-identical, and the engine is never substituted to get past a failure.
2. **Never fake progress.** No invented percentages or fake "checking" bars.
3. **A vote requires a finished download of that exact source.** A stream is not
   a download. Never hide or silently drop a locked vote — say why.
4. **Nothing on the network may sit in front of a click.** Votes sync in the
   background with a time limit; playback never waits for the server.
5. **One vote per person.** No endpoint that lets a client stuff the ballot or
   vote as another device.
6. **Do not store personal data.** A voter is an opaque random id, stored only
   as a hash.
7. **Deliver a Setup plus its matching source** to Drive for every build.
8. **Never claim the desktop window was seen working.** The build sandbox cannot
   attach WebView2; findings come from process, port and HTTP checks.
9. **The server file is shipped, not edited.** Update it from Drive and update
   the hash in `test/verify-source.mjs`.

## 10. Known limits

- Votes are **global per link**, not per movie, region or country. Per-country
  usefulness is not built (it would need the vote to carry a country, which
  raises a privacy question).
- A client can clear its storage and vote again as a "new" device. Tokens stop
  casual ballot stuffing, not a determined person; stopping that needs accounts.
- Storage is a single JSON file — fine for this workload, swap to SQLite past
  roughly hundreds of votes per minute.
- The download record is per device: reinstalling or clearing app storage locks
  every link again. That is deliberate — the record is evidence the file
  arrived on that machine.

## 11. Building the app (not done in this repository)

Needs: `wine wine64 mingw-w64 nsis xvfb p7zip-full python3`.

```bash
cd BlackBoxStream-v75-SOURCE/inst-src
sha256sum -c SHA256SUMS.txt | grep -c ': OK'   # must print 36
cd ../installer && bash build-installer.sh     # -> BlackBoxStream-v75-Setup.exe
```

`build-installer.sh` re-verifies the manifest and refuses to build if the v75
gate is missing, is not the last script, or `BUILD-INFO.txt` does not state the
rule.

Two traps that silently break the build:

1. **Sync the launcher trees.** `installer/launcher-src/app-embedded.cpp` must be
   identical to `launcher-src/app-embedded.cpp`.
2. **The launcher must keep its engine path line:**
   `JoinPath(exe, BBX_PATH, g_appDir, L"blackbox-local-share.exe");`
   Without it `CreateProcess` fails with error 3 and nothing plays — which looks
   exactly like "the app cannot play anything".

## 12. Test suites in the app source

```bash
node test-server.mjs     # 30 checks: correctness, security, latency, restart
node test-sync.mjs       # 12 checks: cross-device votes, no slowdown
node test-votes.mjs      # 14 checks: vote maths, ranking, persistence
node test-votes-dom.mjs  # 13 checks: real DOM, chips render, list re-sorts
node test-gate.mjs       # 21 checks: the v75 rule — no download, no vote
```

`test-sync.mjs`, `test-votes-dom.mjs` and `test-gate.mjs` need `npm install jsdom`.
This repository's own suite (`npm test`) needs nothing.
