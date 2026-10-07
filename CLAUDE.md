# CLAUDE.md

Notes for working on this repo. Everything below was verified against the code
or against a live fly.io deployment, not inferred from the README.

## Live deployment

- URL: https://malika-arthas.fly.dev/
- fly app `malika-arthas`, org `personal`, region `fra`, one `shared-cpu-1x`/256MB machine
- Config lives in `fly.toml` (untracked — it is a local addition, not upstream)
- Image size ~9.6 MB; cost ~$2.53/month

### Deploy / update

```bash
git pull
fly deploy --remote-only --ha=false     # --ha=false is NOT optional, see below
```

`--remote-only` means no local Docker daemon is needed.

## Traps

### 1. Never run more than one machine

Room state is entirely in process memory (`internal/room/manager.go`,
`internal/network/hub.go`). There is no Redis, database, or volume. Two machines
means two disjoint sets of rooms: a client load-balanced to machine B cannot see
a room created on machine A, so people sharing a room key land in what looks
like an empty room at random.

`fly deploy` **creates a second machine by default** for high availability, and
there is no `fly.toml` key to disable it. Always pass `--ha=false`. If a deploy
adds one anyway:

```bash
fly scale count 1
```

Verify with `fly status` — there must be exactly one machine.

For the same reason, stopping the machine destroys every active chat. `fly.toml`
pins `auto_stop_machines = 'off'` and `min_machines_running = 1` deliberately;
scale-to-zero is not safe here.

### 2. There are two Dockerfiles and they are not interchangeable

| File | Port | Contents | Use |
|---|---|---|---|
| `deploy/Dockerfile` | 8080 | Go binary **with frontend embedded** | self-host, fly.io — **this is the one we deploy** |
| `arthas-server/Dockerfile` | 7860 | backend only, no frontend | HuggingFace Spaces |

`deploy/Dockerfile` builds from the **repo root** as context (it COPYs
`arthas-client/` and `arthas-server/`), which is why `fly.toml` sets
`dockerfile = 'deploy/Dockerfile'` rather than being placed in `deploy/`.

Picking `arthas-server/Dockerfile` would leave you needing to host the frontend
separately.

### 3. `ALLOWED_ORIGINS` unset means allow-all

`internal/network/origin.go`: an empty value yields a nil allowlist and
`CheckOriginAllowed` returns true for everything. WebSockets are not covered by
the browser same-origin policy, so leaving this unset lets any website open a
connection to the server. `fly.toml` pins it to `https://malika-arthas.fly.dev`.

**If a custom domain is ever added, this value must be updated** or connections
from the new domain are rejected with 403.

### 4. Frontend WS URL is derived at runtime, not build time

`arthas-client/src/network/websocket.ts` — when `VITE_WS_URL` is unset,
`getDefaultWsUrl()` derives `wss://${location.host}/ws` from `window.location`.
`deploy/Dockerfile` deliberately does not set `VITE_WS_URL`, so the same image
runs on any domain with no rebuild. Do not add it for self-hosted builds.

(`.env.development` does set it, but Vite ignores that file in a production
build, and the root `.dockerignore` excludes `**/.env.*` anyway.)

### 5. Go build tags gate the frontend embed

`internal/static/static_prod.go` is `//go:build !dev` and carries
`//go:embed dist`. A production `go build` therefore **requires**
`internal/static/dist/` to exist and be non-empty, or it fails with
`pattern dist: no matching files found`. `deploy/Dockerfile` satisfies this by
copying the Vite output there between stages.

To build the server alone without touching the frontend:

```bash
go build -tags dev ./cmd/server    # selects static_dev.go, skips embed
```

## Local patches to tracked files

Unlike `fly.toml` and this file (both untracked), these are modifications to
**tracked** upstream files. A `git pull` may revert or conflict with them --
re-check after every upstream update.

### Mobile scroll lock (`body { overflow: hidden }`)

**Symptom:** on iOS Safari, landing on a page made it impossible to scroll by
touch. Scrolling started working only after invoking Safari's "Find selection".

**Cause:** `overflow: hidden` was set on body in two places --
`src/styles/index.css` and the `<body>` class in `index.html`. That is a valid
app-shell assumption for `ChatRoom` only, which is a fixed-height shell
(`h-screen` / `100dvh`) with its own inner scroll container (`MessageList` ->
`flex-1 overflow-y-auto`). Every other page uses `min-h-screen` and relies on
the *document* scrolling: `pages/Home.tsx`, `pages/Hub.tsx`,
`match/MatchPage.tsx`, `match/MatchInvitePage.tsx`, and the `App.tsx` error
boundary. On a short mobile viewport those grow past the screen, and the
overflow was clipped with no scroll container -- unreachable.

**Why "Find selection" revealed it:** an `overflow: hidden` box still has a
scrollable overflow region that can be scrolled *programmatically* -- only user
gestures are disabled. Safari's find scrolls it into view. That signature means
"content overflows an `overflow:hidden` ancestor", NOT a touch-handler problem.

Worth knowing: the touch handlers in `components/MessageBubble.tsx`
(swipe-to-reply) look like a suspect but are not -- they never call
`preventDefault()` and explicitly bail out when vertical movement exceeds
horizontal, so they do not block scrolling.

**Fix applied:** changed both to `overflow-x: hidden` / `overflow-x-hidden`,
which keeps horizontal clipping but lets the document scroll vertically.
`ChatRoom` is unaffected because it never depended on the body rule.

If an upstream change restores a blanket `overflow: hidden`, the alternative fix
is to give each `min-h-screen` page its own `h-screen overflow-y-auto`
container instead.

### Message input mispositioned on touch devices

**Symptom:** on a phone/tablet the message input rendered *beside* the message
list instead of below it; on a laptop it was correctly pinned at the bottom.

**Cause:** `file-transfer/components/DropZone.tsx` short-circuited on touch
devices with `return <>{children}</>`, dropping its wrapper
`<div className="relative flex-1 flex flex-col overflow-hidden">`. That wrapper
is the **flex-col** that stacks message list -> typing indicator -> input. Its
parent, `pages/ChatRoom.tsx:97`, is `flex flex-1 overflow-hidden` -- a flex
**row**. With the wrapper gone, those three became direct children of a row and
laid out horizontally.

**Fix applied:** keep the wrapper on touch devices, skip only the drag handlers
(which was the actual intent of the early return).

Note `isTouchDevice` is `'ontouchstart' in window`, so this also affected
touchscreen laptops, not just phones.

### Voice messages: uniform Ogg/Opus encoding

Browsers do not agree on a recording format, and the server is a blind relay
that cannot transcode, so interop has to be solved client-side.

Originally `voice/recorder.ts` used the browser's own MediaRecorder output:
Chrome/Android produced WebM/Opus (undecodable on iOS Safari) and iOS Safari
fell through to MP4/AAC (unplayable where no AAC decoder exists, common on
Linux). Nothing was mislabeled -- the real mimeType travels in the transfer
metadata and `receiver.ts` rebuilds the blob with it. It was pure codec
mismatch.

Now every platform encodes the same format:

- `voice/opusEncoder.ts` wraps opus-recorder (WASM libopus) and produces
  Ogg/Opus everywhere. It takes a `sourceNode` so `recorder.ts` keeps owning
  getUserMedia, permissions and mic-disconnect handling.
- If anything in that path fails, `recorder.ts` silently falls back to the
  original MediaRecorder behaviour. A new encoder must never be able to make
  recording impossible.
- `voice/transcode.ts` decodes Ogg/Opus to PCM and `voice/wav.ts` re-wraps it
  as WAV, which every browser can play. Done on receipt in `voice/init.ts`,
  gated by `canPlay.ts`.

The WAV step exists to avoid rewriting the player: `player.ts` is built on
HTML5 Audio for pause/resume, and playing decoded PCM would mean
re-implementing that state machine on one-shot AudioBufferSourceNodes. Handing
the existing `<audio>` path a WAV blob leaves player, LRU cache and UI
untouched. `voiceStore.blobCache` (transferId -> blobUrl) is the single
substitution point.

Still unsupported, by design: legacy WebM/Opus and MP4/AAC messages recorded
before this change. Those need a WebM demuxer and an AAC decoder respectively.
They fall through to the "can't play + download" UI.

Bundle note: both WASM payloads are lazy. The encoder worker (~385KB) loads on
first recording, the decoder chunk (~118KB) only when a transcode is needed;
neither is on the initial page load. `vite.config.ts` aliases
`@wasm-audio-decoders/opus-ml` to `voice/opus-ml-stub.ts` -- ogg-opus-decoder
dynamically imports that ~4MB ML decoder behind an option we never pass, and
without the alias it lands in `dist/`, which `go:embed` bakes straight into the
server binary.

## Config surface

Read from env (`cmd/server/main.go`, `internal/match/config.go`); flags take
precedence over env, which takes precedence over defaults.

- `ACCESS_PASSPHRASE` — optional instance passphrase gate (`internal/access`).
  Unset = disabled, server behaves exactly as upstream. Set it with
  `fly secrets set ACCESS_PASSPHRASE=...` so it never lands in git or fly.toml.
  Rotating it invalidates every outstanding cookie, because the HMAC key is
  derived from the passphrase -- rotation doubles as "sign everyone out".
  `/ping` is exempt from the gate; gating it would fail fly's health check and
  restart-loop the machine.
- `PORT` (default 8080) — `main.go:341`
- `ALLOWED_ORIGINS` — comma-separated, exact string match, no wildcards
- `MAX_PUBLIC_ROOMS`, `DISABLE_DAILY_TOPIC`, `DISABLE_RANDOM_MATCH`
- `MATCH_*` — random-match tuning, see `internal/match/config.go`

## Routes

`/ping` (health), `/ws` (WebSocket relay), `/api/hub`, `/api/hub/stats`,
`/` (embedded static UI). Registered in `cmd/server/main.go:293-328`.

## Testing the deployment

```bash
curl -s https://malika-arthas.fly.dev/ping          # -> pong
```

WebSocket handshake checks **must** force HTTP/1.1 — curl negotiates HTTP/2 by
default, where `Connection: Upgrade` is invalid and the server answers 400,
which looks like a broken app but is not:

```bash
KEY=$(head -c 16 /dev/urandom | base64)
curl -s -i -N --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $KEY" \
  -H "Origin: https://malika-arthas.fly.dev" \
  https://malika-arthas.fly.dev/ws          # -> 101 Switching Protocols
```

Swapping in a foreign `Origin` should return 403. Both were confirmed on the
live deployment.

## fly.io cost notes

CPU and RAM are billed separately. `shared-cpu-1x` includes 0.25GB RAM, so at
256MB there is **no RAM line item at all** — dropping from 512MB to 256MB
removed the whole RAM charge rather than halving it. `fra` carries a ~1.154x
regional multiplier over the base rate (`iad`/`ewr` are 1.0x). Shared IPv4 and
Anycast IPv6 are free; a dedicated IPv4 would be $2/month and is not needed.
Published monthly figures assume a 720-hour month, so a full calendar month
runs ~1.5% higher.
