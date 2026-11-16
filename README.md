# BlackBox Stream — shared vote server (v75)

The backend for **BlackBox Stream v75**: viewers vote a movie source up or down,
the link with the most votes gets a **★ Recommended** badge and sorts first, and
those votes are shared between everyone through this server.

One file. No dependencies. Node 18+.

```bash
node server/bbx-vote-server.mjs          # http://localhost:8787/health
```

![ci](https://github.com/whtsel/webcrawler/actions/workflows/ci.yml/badge.svg)

---

## Status

| | |
|---|---|
| Server version | **v75** — `bbx-vote-server.mjs`, 12,491 bytes |
| SHA-256 | `983f99b2f0e5919d5aaddd614dbadfa6bbdb2b382a1e722c0d48a3aae08f9ace` |
| Verified against | Drive `bbx-vote-server.mjs` (`1iePj17PP5XuTGTRW4fhzG46cdAhWhmLY`) — **byte-identical** |
| Runtime | Node 18+, no build step, no database |
| Tests | 59 checks, all green on Node 18 / 20 / 22 |
| Deployed at | _not yet — pick a host in [docs/DEPLOY.md](docs/DEPLOY.md#decision-table)_ |

The server is shipped untouched. `npm run verify` fails the build if that hash
ever changes, so an edit cannot slip in by accident.

## What it does

- **Batch reads** — a whole source page is one request (`GET /votes?keys=…`),
  answered from memory. Measured here: 100 keys in ~2–5 ms.
- **One vote per person** — the server signs each device id with an HMAC and
  only accepts signed votes. Forged or borrowed tokens get `403`.
- **No personal data** — a voter is an opaque random id, stored only as a
  16-character hash. No IPs, keys or tokens in logs.
- **Bounded** — 8 KB body cap, 200-key cap, per-IP and per-voter rate limits,
  8 s request timeout.
- **Never in front of a click** — the app fetches votes in the background with a
  2.5 s ceiling and a 30 s cache. If this server is down, playback is unaffected:
  users just see their own votes.

The v75 rule that governs the client — **a vote requires a finished download of
that exact source** — is described in [docs/BLACKBOX.md](docs/BLACKBOX.md#3-the-v75-rule--a-vote-requires-a-finished-download).

## API

| Method | Path | Body / query | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, keys, uptime, version }` |
| `GET` | `/votes` | `?keys=k1,k2,…` (max 200) | `{ ok, votes: { key: { up, down, score } }, ms }` |
| `POST` | `/vote` | `{ key, dir, voter, token }` | `{ ok, votes, mine }` |
| `POST` | `/token` | `{ voter }` | `{ ok, token }` |

`dir` is `1` (recommend), `-1` (did not work), `0` (clear). `key` is a
`magnet:…` URI, an infohash or a title hash.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `BBX_VOTES_FILE` | `./votes.json` | where votes are stored |
| `BBX_VOTES_SECRET` | _(empty)_ | optional shared key, sent as `x-bbx-key` |
| `BBX_VOTES_TOKEN_KEY` | random per boot | HMAC key; set it so tokens survive restarts |
| `BBX_VOTES_RATE_READ` | `240` | reads per IP per minute |
| `BBX_VOTES_RATE_WRITE` | `30` | votes per IP per minute |
| `BBX_VOTES_RATE_VOTER` | `20` | votes per voter per minute |

## Run it

```bash
# plain node
npm start

# docker compose (port 8787, votes kept in ./data)
docker compose up --build

# docker, anywhere
docker build -t bbx-vote-server .
docker run -p 8787:8787 -v bbx-votes:/data -e BBX_VOTES_FILE=/data/votes.json bbx-vote-server
```

## Host it

GitHub hosts the code, the CI and a ready container image; GitHub Pages cannot
run a Node process, so the server itself needs a small runtime. Configs for each
option are in this repo, and the full walkthrough is
[docs/DEPLOY.md](docs/DEPLOY.md):

| Host | Config in repo | Votes persist | Notes |
|---|---|---|---|
| **Render** | `render.yaml` | no (free tier) | fastest public HTTPS URL, no CLI |
| **Fly.io** | `fly.toml` | yes (volume) | recommended; TLS automatic |
| **Railway** | `railway.json` | yes (volume) | dashboard-driven |
| **Any VPS** | systemd + Caddy recipe | yes | full control |
| **Docker** | `Dockerfile` | depends on mount | image also published to `ghcr.io/whtsel/webcrawler/vote-server` |

After it is live, point the app at it with **one line** in
`inst-src/web/index.html`:

```html
window.BBX_VOTES_SERVER = window.BBX_VOTES_SERVER || "https://your-server.example";
```

Then refresh `SHA256SUMS.txt` (36/36 must pass) and rebuild the installer — see
[docs/DEPLOY.md §7](docs/DEPLOY.md#7-connect-the-app--the-one-line-edit).
Leaving that string empty keeps the app local-only; nothing breaks.

## Repository layout

```
server/bbx-vote-server.mjs   the v75 server, byte-identical and verified
test/verify-source.mjs       hash gate — proves the file is untouched
test/smoke.mjs               59-check end-to-end suite (no dependencies)
Dockerfile                   node:22-alpine, non-root, /data volume
docker/entrypoint.sh         claims the volume, then drops privileges
render.yaml / fly.toml /     one-click deploy configs
railway.json / Procfile
docker-compose.yml           local run
docs/BLACKBOX.md             everything about the app: the v75 rule, versions,
                             file IDs, build traps, rules, limits
docs/DEPLOY.md               hosting, CI, connecting the app, troubleshooting
```

## Test it

```bash
npm run check     # verify the hash, then run the 59-check suite
```

CI runs that on Node 18, 20 and 22, then builds the Docker image and does a real
token → vote → read round trip inside the container.

## Ground rules

1. Never modify, re-sign or swap the engine binaries (`blackbox-core.exe`,
   `blackbox-local-share.exe`) — they stay byte-identical.
2. A vote requires a finished download of that exact source. A stream is not a
   download, and a locked vote is never hidden — it says why.
3. Nothing on the network may sit in front of a click.
4. One vote per person; no endpoint that lets a client stuff the ballot.
5. No personal data — voters are hashes of opaque random ids.
6. This file is shipped, not edited: new versions come from Drive with a new
   hash recorded in `test/verify-source.mjs`.

No licence has been declared for this project yet.
