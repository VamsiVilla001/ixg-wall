# IXG Wall architecture

IXG Wall monitors 20–30 YouTube live feeds for BGMI esports broadcasts. Its job is to keep every feed close to its live edge with no buffering, and to show legible per-feed health. One codebase runs two ways:

| | Laptop (default) | Hosted (`IXG_HOSTED=1`) |
|---|---|---|
| Started by | `IXG Wall.exe`, `Start IXG Wall.cmd`, `npm run wall` | systemd on a Linux server (DEPLOY.md) |
| Sign-in | none | one shared password, 30-day session cookie |
| Managed wall window | yes (Chrome/Edge app window, software decode) | no |
| Laptop telemetry (CPU, memory, network, GPU) | yes | no: the server isn't the screen |
| Data folder | `%LOCALAPPDATA%\IXG Wall` | `IXG_DATA_DIR`, e.g. `/var/lib/ixg-wall` |

There are no runtime dependencies: Node's standard library on the server, plain browser JavaScript in the page. `npm install` only fetches build tools for the exe.

## Layout

```
server.js               HTTP server: static files, sign-in gate, JSON API, SSE stream
backend/
  config.js             every environment setting, validated at startup
  auth.js               shared-password sign-in, signed session cookie, lockout
  secrets.js            YouTube key + session-signing key (secrets.json), never sent to pages
  wall-store.js         the wall: feeds + settings (wall.json), versioned
  youtube.js            YouTube Data API poller + 24 h audience history (youtube-history.json)
  extension.js          ships the Feed Meter: its fixed ID and version for the page's install
                        check, and /extension/ixg-wall-feed-meter.zip built from extension/
  youtube-ingest.js     channel sign-in (Google OAuth, read-only) and ingest health per feed:
                        liveBroadcasts → bound stream → liveStreams health, resolution, fps, issues
  telemetry.js          laptop CPU/memory/network/GPU samples (a heartbeat when hosted)
  wall-browser.js       launches and supervises the managed wall window (laptop only)
  paths.js              where the data folder is
  assets.js             reads public/ from disk, or from inside the exe
public/
  index.html            the wall's markup: top bar, settings sheet, feed sheet, tile template
  app.js                the whole front end (one IIFE, sections marked with banner comments)
  links.js              YouTube link parsing; reads links and feed names out of pasted messages
                        (Add stream). Pure functions, unit-tested in test/links.test.js
  style.css             SKWAD design system, Live (dark) mode
  login.html            sign-in page (hosted)
  fonts/                Anybody, Manrope, JetBrains Mono
extension/              IXG Wall Feed Meter: Chrome extension that measures each player from
                        inside (real bitrate, data received, connection speed, latency mode)
tools/check-feed-meter.js    end-to-end check of the extension in a throwaway Chrome
telemetry/win-counters.ps1   Windows performance-counter agent (network, GPU engines)
build/build-exe.js      bundles server + backend, embeds public/, writes dist/IXG Wall.exe
deploy/                 Linux server setup: setup.sh, update.sh, systemd unit, Caddy sites
test/                   backend smoke tests (npm test)
```

## Terms: what happens where

A frame travels **encoder → YouTube → network → this PC's player → screen**. The wall uses these terms everywhere (UI, event log, code comments). Settings → "What the numbers mean" explains them to operators.

| Term | Where | Meaning | In code |
|---|---|---|---|
| Ingest | encoder → YouTube | how the encoder's stream arrives (channel sign-in) | `ingestInfo()` |
| Edge delay | YouTube | least delay this feed can have; set mostly by the broadcast's latency mode. Can't be released from the wall | `tile.baseline` |
| Connection | network | player's connection speed against the bitrate (Feed Meter) | `tile.headroom()` |
| Buffer ahead | this PC | downloaded, waiting to play; a cushion, not delay | `tile.buffer` |
| Rebuffering | this PC | player ran dry and stopped; adds to Behind edge | `stats.stalls`, `countingStall` |
| Behind edge | this PC | player's distance behind the newest video; the build-up the wall releases | `tile.drift` |
| Delay | whole chain | YouTube's stamp on a frame → this screen = Edge delay + Behind edge | `tile.latency` |
| Sync | wall | offset from the wall's shared delay | `tile.syncOffset()` |

## Sync

All live feeds carry the same input, so `updateSync()` holds them at one shared delay:
- **The target** is the slowest member's edge delay plus `syncMarginSec`. It's held steady unless it moves by more than 0.5 s.
- **Correcting a feed:** each member's offset (delay − target) is corrected in `keepInSync()`.
  - Up to 10 s, by playing at 1.25× or 0.75× for exactly offset ÷ 0.25 s (a timer ends the nudge).
  - Further, by seeking. Seeks land on YouTube segment boundaries, measured up to ~7 s short, so speed finishes the job.
  - A running speed correction stops when its target changes, automatic correction is disabled, or playback stops. New measurements determine the next correction.
  - A seek keeps the last measured delay until fresh timestamps arrive; the requested position is not reported as a measured result. A sync seek does not establish a new live-edge baseline.
- **Holding back** uses YouTube's live rewind (DVR).
- **Left out of the group:** a feed whose edge delay is more than 15 s past the median, and one that would need holding back with DVR off (including holding back for the sync margin). Both keep their own live edge.

Measured with two players of one live stream: nudges land within 0.1–0.2 s, and a 15 s push came back in one jump.

## How a feed stays live (public/app.js)

Each feed is a `Tile` wrapping a YouTube IFrame player. The main loop (`restartLoop`) runs every `checkIntervalSec` and, for each tile:

1. **Measures lag.** `now − player.getMediaReferenceTime()` gives the wall-clock age of the frame on screen. It's undocumented but present on live streams. `getDuration()` stays frozen on live streams, so it can't be used.
   - The median of 5 samples is the tile's lag.
   - The lowest lag a tile has reached since it loaded is its baseline. Drift is lag minus baseline.
2. **Corrects drift.**
   - Up to 15 s behind: play at 1.25× until it's back.
   - Further behind: seek forward. Seeking past the live edge clamps to it.
   - Three jumps within two minutes escalate to a full player refresh. A jump that gets no closer means the edge itself moved, and the new lag is accepted.
3. **Recovers.** It refreshes a tile that's stuck buffering, frozen while "playing", or never became ready. Paused players are resumed, and ended or erroring feeds are retried with backoff.
4. **Refreshes on a schedule.** Every `hardReloadMin` minutes the player is destroyed and recreated, which releases its buffer and memory. Refreshes are staggered across tiles (`restagger`).

Around the tiles:
- **Load queue** (`requestMount`, `pumpQueue`): feeds start a few at a time, priority feeds first.
- **Bandwidth** (`allocate`, `updateCongestion`): quality follows the player's render size, which is YouTube's only lever. Priority feeds get bigger renders when the budget allows. Stalls on several feeds at once shed those boosts.
- **Performance governor** (`updatePerf`): sustained high CPU or memory (laptop telemetry), or the browser's own CPU-pressure signal, sheds boosts and postpones refreshes. Hosted, only the browser's signal is available.

YouTube embed limits, measured on the wall laptops:
- Quality requests (`setPlaybackQuality`, `vq`) are ignored. Quality follows render size, and only upward, with a 480p floor.
- `isAtLiveHead` is unreliable.
- Muted embeds turn captions on; the wall unloads the captions module.

## Data flow

```
          PUT /api/wall (feeds, settings)            poll every ytPollSec
 page ───────────────────────────────► server ─────────────────────────► YouTube Data API
  ▲   GET /api/wall, /api/config          │
  └──── SSE /api/telemetry ◄──────────────┘  events: (default) telemetry/heartbeat,
                                                     youtube (audience numbers), wall (changed)
```

- **Every window shares one wall.** The page keeps a local copy (localStorage) for when the backend is offline, but the server's `wall.json` is authoritative. When another window saves, the server broadcasts `wall`, and other pages offer to reload.
- **The wall checks for the Feed Meter before starting feeds.** On load it fetches `chrome-extension://<id>/manifest.json` (web-accessible, fixed ID). If that fails, the install popup holds the feeds back until the extension appears or the operator continues without it.
- **The Feed Meter talks only to the page that asks.** The wall sends `ixg-wall-hello` into each of its player frames; the extension in that frame answers to that origin only, every 2 s, with `ixg-meter` reports. The wall accepts a report only from the tile's own frame and origin, and range-checks every field.
- **The channel sign-in lives on the server.** It's a refresh token in `secrets.json`. Pages see only `{ signedIn, channel, videos: { id: health… } }`, and the stream key (`cdn.ingestionInfo`) is never requested.
- **The YouTube key goes in, never out.** It reaches the server only through `POST /api/youtube/key` and lives in `secrets.json`. Pages learn `{ set, source, last4 }`. Older walls that kept the key in `wall.json` are migrated on startup.

## HTTP API

Signed-in only when a password is set; changes also need the `X-IXG-Wall: 1` header and a same-site `Origin`.

| Method & path | What |
|---|---|
| `GET /healthz` | `{ ok: true }`, no sign-in; for load balancers and `update.sh` |
| `POST /api/login` · `POST /api/logout` | sign in (`{ password }`) / out |
| `GET /api/config` | `{ hosted, auth, ytKey }`: the page adapts its UI to this |
| `GET /api/wall` · `PUT /api/wall` | the wall `{ version, wall: { settings, streams } }` |
| `GET /api/telemetry` | Server-Sent Events stream (see above) |
| `GET /api/youtube` · `GET /api/youtube/history?id=` | latest audience numbers · one feed's 24 h series (`total` for the wall) |
| `POST /api/youtube/key` | `{ key }` saves it; `""` removes it |
| `POST /api/youtube/oauth/client` | `{ clientId, clientSecret }` for the channel sign-in; empty removes it |
| `GET /api/youtube/oauth/start` · `GET /api/youtube/oauth/callback` | Google sign-in round trip (popup); the callback checks a one-time `state` |
| `POST /api/youtube/oauth/signout` | forget the channel and revoke the token at Google |
| `GET /api/status` | latest telemetry + wall-window status |
| `POST /api/wall-browser` | `{ action: launch \| relaunch, decode }` (laptop only) |

## Files on disk (data folder)

| File | Holds |
|---|---|
| `wall.json` | feeds and settings, with a version number |
| `secrets.json` | YouTube key, session-signing key (mode 600) |
| `youtube-history.json` | 24 h audience history, quota used today |
| `backend.json`, `wall-profile/` | laptop only: wall-window decode mode, pid, browser profile |
