# Deploy the BlackBox Stream vote server

Goal: a public **HTTPS** URL that answers `/health`, backed by a persistent
`votes.json`, and then one line changed in the app so every user sees the same
scores.

---

## 0. First, the honest bit about GitHub

GitHub stores and builds code; it does not keep a Node process running:

| GitHub feature | Can it host this? | Why |
|---|---|---|
| **Pages** | No | static files only — no Node process, no `/vote` endpoint |
| **Actions** | No (effectively) | jobs are capped at ~6 h and have no stable URL |
| **Codespaces** | No | sleeps, and the URL is not meant to be a public API |
| **Container registry (GHCR)** | Half | publishes a ready image — something else must run it |

So the setup here is **GitHub as the source of truth and the build system**, and
a small runtime elsewhere for the actual process. Everything is driven from this
repository: push to `main`, CI proves the server works, and the same commit
builds the image or triggers the host's deploy. Pick one of the runtimes below.

### Decision table

| Option | Cost | Votes survive restarts? | Setup | Good for |
|---|---|---|---|---|
| **Render** (§1) | free tier | **no** on free (ephemeral) | ~5 min, no CLI | getting a URL today |
| **Fly.io** (§2) | a few $/month | **yes** (volume) | ~10 min, CLI | the real deployment |
| **Railway** (§3) | trial credit, then ~$5/mo | **yes** (volume) | ~5 min | easy dashboard |
| **Any VPS** (§4) | ~$4–6/mo | **yes** | ~15 min, SSH | full control |
| **Docker anywhere** (§5) | varies | depends on the mount | ~2 min | already have a host |

The app tolerates downtime — a dead server means users see local-only votes,
never a broken click — but a server that loses `votes.json` resets everyone's
scores, so use a volume for anything real.

---

## 1. Render (fastest way to a public HTTPS URL)

1. Push this repo to GitHub (already done if you are reading it there).
2. Go to **render.com → New + → Blueprint**, pick this repository. Render reads
   `render.yaml`, builds the `Dockerfile`, and creates `https://<name>.onrender.com`.
3. Wait for the first deploy, then open `https://<name>.onrender.com/health`.
   You should see `{"ok":true,"keys":0,"uptime":…,"version":1}`.

Free-plan caveats, stated plainly:

- The filesystem is **ephemeral** — every redeploy or restart starts from zero
  votes. Upgrade the service and uncomment the `disk:` block in `render.yaml`
  if that matters.
- Free instances **spin down when idle** and take ~50 s to wake, so the first
  visitor after a quiet period may see scores arrive a moment later. The app
  handles this (background fetch, 2.5 s ceiling), but a Fly machine (§2) is
  warmer.

`render.yaml` already sets `BBX_VOTES_TOKEN_KEY` with `generateValue: true`, so
tokens stay valid across restarts of the same instance.

---

## 2. Fly.io (recommended — votes persist, TLS automatic)

Requires the `flyctl` CLI and a Fly account.

```bash
# 1. create the app from this repo's fly.toml (keeps your config)
fly launch --no-deploy --copy-config --name bbx-vote-server

# 2. create the volume the votes live on (jnb = Johannesburg, nearest to Ghana)
fly volumes create bbx_votes --size 1 --region jnb

# 3. fixed HMAC key so client tokens survive restarts
fly secrets set BBX_VOTES_TOKEN_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"

# 4. ship it
fly deploy

fly status
fly open /health          # or: curl -s https://bbx-vote-server.fly.dev/health
```

`fly launch` may rename the app if `bbx-vote-server` is taken — keep whatever it
picks and update your notes, not the file.

Notes:

- `fly.toml` mounts the volume at `/data` and sets `BBX_VOTES_FILE=/data/votes.json`,
  so votes survive deploys, restarts and machine replacement.
- `min_machines_running = 1` keeps the server warm so the ★ badge is right on the
  first paint. Set it to 0 to save money and accept a cold first request.
- Scale with `fly scale memory 256` if you want the smallest machine.

---

## 3. Railway

1. **railway.app → New Project → Deploy from GitHub repo**, pick this repo.
   `railway.json` sets the Dockerfile builder and the `/health` healthcheck.
2. **Add a Volume**: right-click the service → *Attach Volume* → mount path
   `/data`.
3. **Variables**: `BBX_VOTES_FILE=/data/votes.json` and a fixed
   `BBX_VOTES_TOKEN_KEY` (any long random string).
4. **Settings → Networking → Generate Domain**, then open `/health`.

Without the volume, votes are lost whenever the container is replaced.

---

## 4. Any VPS (systemd + Caddy)

Unchanged from the project handoff — this is the setup the app was designed
against.

```bash
# 1. the file
sudo mkdir -p /opt/bbx /var/lib/bbx && cd /opt/bbx
sudo curl -fsSL -o bbx-vote-server.mjs \
  https://raw.githubusercontent.com/whtsel/webcrawler/main/server/bbx-vote-server.mjs
sudo chmod 644 bbx-vote-server.mjs

# 2. a fixed token key
sudo sh -c 'echo "BBX_VOTES_TOKEN_KEY=$(head -c 32 /dev/urandom | base64 | tr -d "/+=" | head -c 40)" > /etc/bbx.env'
sudo chmod 600 /etc/bbx.env

# 3. the service
sudo tee /etc/systemd/system/bbx-votes.service >/dev/null <<'EOF'
[Unit]
Description=BlackBox Stream vote server
After=network.target

[Service]
WorkingDirectory=/opt/bbx
EnvironmentFile=/etc/bbx.env
Environment=PORT=8787
Environment=BBX_VOTES_FILE=/var/lib/bbx/votes.json
ExecStart=/usr/bin/node /opt/bbx/bbx-vote-server.mjs
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now bbx-votes
curl -s localhost:8787/health
```

TLS in front of it — the app is served from `127.0.0.1`, so plain HTTP would be
blocked as mixed content:

```
# /etc/caddy/Caddyfile
votes.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
curl -s https://votes.example.com/health
```

Caddy passes `X-Forwarded-For`, which the server already reads for rate limits.

---

## 5. Docker image from GitHub Container Registry

Every push to `main` builds and publishes:

```
ghcr.io/whtsel/webcrawler/vote-server:latest
```

Run it anywhere:

```bash
docker run -d --name bbx-votes \
  -p 8787:8787 \
  -e PORT=8787 \
  -e BBX_VOTES_FILE=/data/votes.json \
  -e BBX_VOTES_TOKEN_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)" \
  -v bbx-votes:/data \
  --restart unless-stopped \
  ghcr.io/whtsel/webcrawler/vote-server:latest
```

If the package is private, `docker login ghcr.io` with a token that has
`read:packages` first. Locally, `docker compose up --build` uses port 8787 and
`./data` on the host.

---

## 6. What CI proves on every push

`.github/workflows/ci.yml`:

- `test/verify-source.mjs` — the server file is still byte-identical to v75
  (`983f99b2…f9ace`). If a future build arrives, this is the one line to update.
- `test/smoke.mjs` on Node 18, 20 and 22 — 59 checks against the real server:
  health, tokens, vote maths, one-vote-per-device, direction changes, batch
  reads, forged tokens → 403, bad input → 400, oversized body → 413, unknown
  route → 404, 100-key read timing, and votes surviving a restart.
- Docker job — builds the image, runs the container, and does a real
  token → vote → read round trip over HTTP.

Run the same locally:

```bash
npm run check      # verify + smoke
```

---

## 7. Connect the app — the one-line edit

In `inst-src/web/index.html` of `BlackBoxStream-v75-SOURCE.zip`:

```html
<!-- before -->
<script>window.BBX_VOTES_SERVER = window.BBX_VOTES_SERVER || "";</script>

<!-- after -->
<script>window.BBX_VOTES_SERVER = window.BBX_VOTES_SERVER || "https://bbx-vote-server.fly.dev";</script>
```

That is the only client change. Then refresh the integrity manifest and rebuild:

```bash
cd BlackBoxStream-v75-SOURCE/inst-src
python3 - <<'PY'
import hashlib
p = 'SHA256SUMS.txt'
raw = open(p, 'rb').read().decode('utf-8'); out = []
for line in raw.split('\r\n'):
    if not line.strip():
        out.append(line); continue
    digest, path = line.split('  ', 1)
    try:
        new = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    except FileNotFoundError:
        out.append(line); continue
    out.append(f'{new}  {path}' if new != digest else line)
open(p, 'wb').write('\r\n'.join(out).encode('utf-8'))
PY

sha256sum -c SHA256SUMS.txt | grep -c ': OK'   # must print 36
cd ../installer && bash build-installer.sh     # -> BlackBoxStream-v75-Setup.exe
```

Ship the new Setup **and** its matching source zip to Drive (project rule 7),
and record the new hashes.

> Leave `BBX_VOTES_SERVER` empty and the app keeps votes on the device only,
> exactly as before. Nothing breaks, nothing waits.

---

## 8. Verify end to end

```bash
BASE=https://bbx-vote-server.fly.dev

curl -s $BASE/health
# {"ok":true,"keys":0,"uptime":12,"version":1}

# a device token
TOKEN=$(curl -s -X POST $BASE/token -H 'content-type: application/json' \
  -d '{"voter":"manual-test-device-01"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

# one vote
curl -s -X POST $BASE/vote -H 'content-type: application/json' \
  -d "{\"key\":\"btih:0123456789abcdef0123456789abcdef01234567\",\"dir\":1,\"voter\":\"manual-test-device-01\",\"token\":\"$TOKEN\"}"
# {"ok":true,"votes":{"up":1,"down":0,"score":1},"mine":1}

# read it back
curl -s "$BASE/votes?keys=btih:0123456789abcdef0123456789abcdef01234567"
# {"ok":true,"votes":{"btih:…":{"up":1,"down":0,"score":1}},"ms":0.4}
```

A forged token must be refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/vote \
  -H 'content-type: application/json' \
  -d '{"key":"btih:0123456789abcdef0123456789abcdef01234567","dir":1,"voter":"attacker-0001","token":"aaaaaaaaaaaaaaaaaaaaaaaa"}'
# 403
```

On a device, the same check is: download a film, vote ★, then confirm the same
score appears on a second device.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| App still shows only local votes | `BBX_VOTES_SERVER` empty, or the installer was not rebuilt | do §7, confirm the URL is in the shipped `index.html` |
| `keys` resets to 0 after a deploy | no persistent volume | attach a volume at `/data` (Fly/Railway), or accept it on Render free |
| Everything 401s | `BBX_VOTES_SECRET` is set but the client does not send `x-bbx-key` | unset the secret, or ship the header |
| `403 invalid voter token` from a real client | token key rotated without restarting clients | keep `BBX_VOTES_TOKEN_KEY` fixed |
| `429 too many votes` | rate limit (30/IP/min, 20/voter/min) | raise `BBX_VOTES_RATE_WRITE` / `BBX_VOTES_RATE_VOTER` |
| `413` on vote | body over 8 KB | the client is sending too much — fix the client |
| Votes appear seconds late | server was cold (Render free spins down) | keep it warm: Fly with `min_machines_running = 1` |
| Browser blocks the request | endpoint is HTTP, page is HTTPS-ish/`file://` | put TLS in front (Caddy, Fly, Render all do this) |
| `health` fine, votes not shared | requests point at different servers (old URL in a shipped build) | check `window.BBX_VOTES_SERVER` in the installed app |

## 10. Operating it

- **Back up** by copying `votes.json` — nothing else is stateful.
- **Rotate** `BBX_VOTES_TOKEN_KEY` only with a redeploy; clients silently fetch
  a new token once.
- **Watch** `GET /health` → `keys` (how many sources have votes) and `uptime`.
- **Logs** contain no IPs, keys or tokens by design, so do not expect analytics
  there.
- **Grow** past hundreds of votes per minute by swapping the `db` object for
  SQLite; the HTTP surface stays the same.
