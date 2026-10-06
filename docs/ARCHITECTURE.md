# IXG Wall architecture

IXG Wall monitors 20–30 YouTube live feeds for BGMI esports broadcasts. Its job is to keep every feed close to its live edge with no buffering, and to show legible per-feed health. One codebase runs two ways:

| | Laptop (default) | Hosted (`IXG_HOSTED=1`) |
|---|---|---|
| Started by | `Start IXG Wall.cmd`, `npm run wall` | systemd on a Linux server (DEPLOY.md) |
| Sign-in | none (everyone is an admin) | admin: the wall password · user: a link an admin generated; 30-day session cookie |
| Managed wall window | yes (Chrome/Edge app window, software decode) | no |
| Laptop telemetry (CPU, memory, network, GPU) | yes | no: the server isn't the screen |
| Data folder | `%LOCALAPPDATA%\IXG Wall` | `IXG_DATA_DIR`, e.g. `/var/lib/ixg-wall` |

There are no runtime dependencies: Node's standard library on the server, plain browser JavaScript in the page. There is nothing to install or build.

## Layout

```
server.js               HTTP server: static files, sign-in gate, JSON API, SSE stream
backend/
  config.js             every environment setting, validated at startup
  auth.js               sign-in: signed session cookie naming the role (admin | user), lockout
  user-links.js         the links that sign browsers in as users (kept in secrets.json)
  secrets.js            storage for the YouTube key, OAuth client, channel sign-ins and the
                        session-signing key (secrets.json), never sent to pages
  google-credentials.js anyone's YouTube key and Google OAuth client, checked with Google before
                        they're saved; the channel sign-ins (any number) and their tokens
  wall-store.js         the wall: feeds + settings (wall.json), versioned
  youtube.js            YouTube Data API poller + 24 h audience history (youtube-history.json)
  auto-capture.js       when an automatic source screenshot is due (a feed's new CCV high, at
                        most once per 2 or 4 min; a broadcast seen ending); pages with the Feed Meter
                        claim each job (/api/capture/claim, first wins) and report back
  extension.js          ships the Feed Meter: its fixed ID and version for the page's install
                        check, and /extension/ixg-wall-feed-meter.zip built from extension/
  youtube-ingest.js     ingest health per feed, read through the signed-in channel that owns it:
                        liveBroadcasts → bound stream → liveStreams health, resolution, fps, issues
  telemetry.js          laptop CPU/memory/network/GPU samples (a heartbeat when hosted)
  wall-browser.js       launches and supervises the managed wall window (laptop only)
  paths.js              where the data folder is
  assets.js             reads public/, extension/ and the telemetry agent from the project
public/
  index.html            the wall's markup: top bar, settings sheet, feed sheet, tile template
  app.js                the whole front end (one IIFE, sections marked with banner comments)
  links.js              YouTube link parsing; reads links and feed names out of pasted messages
                        (Add stream). Pure functions, unit-tested in test/links.test.js
  style.css             IXG component styles, dark console theme
  login.html            sign-in page (hosted)
  fonts/                Space Grotesk and Manrope (IXG variable fonts)
extension/              IXG Wall Feed Meter: Chrome extension that measures each player from
                        inside (meter.js: bitrate, data received, connection speed, audio),
                        and captures source screenshots on request or automatically (capture.js: the workflow
                        in its service worker; courier.js: relays the page's request from a
                        player frame; source-youtube.js: what to wait for and crop on YouTube)
tools/check-feed-meter.js    end-to-end check of the extension in a throwaway Chrome
telemetry/win-counters.ps1   Windows performance-counter agent (network, GPU engines, the
                             managed wall window's memory)
deploy/                 Linux server setup: setup.sh, update.sh, systemd unit, Caddy sites
test/                   backend smoke tests (npm test)
```

## Terms: what happens where

A frame travels **encoder → YouTube → network → this PC's player → screen**. The wall uses these terms everywhere (UI, event log, code comments). Settings → "What the numbers mean" explains them to operators.

| Term | Where | Meaning | In code |
|---|---|---|---|
| Ingest | encoder → YouTube | how the encoder's stream arrives (the owning channel's sign-in) | `ingestInfo()` |
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

## Layouts

`settings.layoutMode` is `scroll` (fixed columns), `fit` (every feed on screen) or `preset`.
- **Presets** (`LAYOUT_PRESETS`, plus `settings.customLayout` from the builder) are boxes on a small grid, mapped onto a 12 × 12 grid of CSS grid lines (`layoutUnits()`). Every preset fills the screen exactly; `test/layouts.test.js` checks this.
- **Placement:** the preset repeats a screen-high page at a time for every feed: feed *i* takes box *i* mod *k* on page *i* / *k*, for *k* boxes per page, with boxes filled biggest first in wall order (`streams`). Scrolling snaps to pages. `placeTiles()` sets each tile's `grid-area` and CSS `order` rather than moving it in the page, because a YouTube iframe moved in the DOM reloads.
- **Dragging a feed** (`feedDragPress` and the code after it) works in every layout. Pointer events start a drag after 6 px, so a plain click on the picture still picks the audio. The lifted box follows the pointer by `transform`. The order under it changes live (`placeTiles(L, order)`), and the other feeds slide using FLIP: measure, re-place, animate the difference. Near the wall's edge it scrolls, with page snapping off meanwhile. Dropping saves `streams`; Esc cancels. Players are never moved in the DOM.
- **Quality:** presets count as scroll mode, so feeds on screen get "Feeds stream at" (`onScreenQuality()`).

## Timelines

Each tile has a seek bar along the top of its info bar, and the **wall timeline** under the grid moves every live feed to the same moment. Both use YouTube's live rewind (DVR), and both are built on the sync controller above.
- **Measured from the player:** `playerInfo.progressState` gives `seekableStart`, `seekableEnd` (the live edge) and `current` on the same scale as `getCurrentTime()`, and `ingestionTime`, YouTube's stamp on the frame. Stamp − position is constant within a stream, so a position converts to a real time (`tile.span.k`). Live rewind kept up to 12 h on a 24/7 stream, and a whole broadcast on a 4 h one. While paused, YouTube stops moving the edge, so a paused tile works its edge out from the stamp and its edge delay.
- **The wall timeline** is in seconds of delay. Live is `timeline.liveDelay`, the delay sync holds feeds at (or the median edge delay with sync off). Moving it sets `timeline.delay`. `updateSync()` then makes that the target for every feed that can rewind that far, sync on or off, and `seekStamp()` sends each straight to the same stamp. Measured on 4 live feeds: all landed within ~3 s, and sync closed them to 0.1 s.
  - Left live: DVR off, YouTube doesn't keep that far back, or the feed's own edge is later than the timeline.
  - **Pause** stops every follower on one frame (`timeline.paused`). Paused feeds aren't auto-resumed, alerted, or refreshed. **Play** continues from that frame, at the delay the pause added.
- **Viewer counts on hover** (`scrubber` with `graph`, `drawViewerGraph`): the bar's ends as epoch ms (a tile: player seconds + `span.k`; the wall: `nowS − delay`) map the backend's audience history (`/api/youtube/history`, fetched on first hover and again after each YouTube report, `historyFor`) onto the bar's own axis, so the count under the pointer is the count at that moment of the stream. Peak and low in view are marked; a gap in the readings is left open.
- **A tile's own seek bar** puts that feed on its own timeline (`tile.own.delay`): out of the group, and held at that delay by `keepInSync()` until it's dropped at live or **Jump live** is pressed. The next wall timeline move brings every feed back. A recording's bar simply seeks.
- **Held, never pulled to live:** a held feed is exempt from `MAX_LAG_S` and edge jumps. A feed refreshed while held restarts at live and is sent back after one sample.
- **Not saved:** each window has its own timeline, and a reloaded wall starts live. **Jump live** / **Go live** brings every feed back.

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
4. **Refreshes on a schedule, if asked.** `hardReloadMin` is 0 (off) by default: a playing feed is never touched. Set, every that many minutes the player is destroyed and recreated, which releases its buffer. Refreshes are staggered across tiles (`restagger`).
5. **Holds a starved feed.** When the channel sign-in says the encoder sends nothing while YouTube keeps the broadcast on air (`ingestStoppedAt`), the player can only buffer or end and a refresh can't help. The tile shows **No ingest**, the stuck-buffer and retry refreshes are skipped, the player is tried again every 5 minutes, and it restarts the moment ingest resumes. When YouTube says the broadcast is over, the tile says Ended (grey seek bar, no alert) and the player keeps showing whatever YouTube serves on that link, the recording included.
5. **Offloads memory** (`startOffload`, `updateOffload`). How memory is held, measured and released:
   - **Where the memory goes.** The players of each YouTube site (youtube.com, youtube-nocookie.com) share one browser process, and that process keeps growing for as long as it runs. That's the "High memory usage" Chrome shows on the wall tab: 838 MB on the wall laptop after a few hours, with player processes of 325–495 MB. Refreshing a player loads the new one into the same process (measured: no smaller afterwards), so refreshes don't give memory back.
   - **Releasing it.** Only ending the process does. Chrome ends a process about 11 s after its last player closes (measured); a player opened before then reuses it. So an offload:
     1. moves site A's feeds to B, one at a time (each restart like a normal refresh), and waits 20 s, so A's process ends;
     2. moves every feed onto a fresh A, and waits again, so B's process ends;
     3. moves B's own feeds back to a fresh B.

     Every feed restarts twice, one at a time, and the feed being listened to goes last in each step. Checked in Chrome: both original player processes were gone afterwards.
   - **Measuring.** A page can't read its own tab's memory. In ordinary Chrome, `performance.memory` is a rounded figure refreshed every 20 minutes (measured: it stayed at 10 MB while the page grew by about 170 MB), and `measureUserAgentSpecificMemory` needs cross-origin isolation, which YouTube embeds rule out. So the telemetry agent measures the managed wall window from Windows: every process of its browser carries the profile folder on its command line, and the wall tab is the sum of its renderers' private bytes (`wallMem.tabMB`).
   - **When.** In the managed window, an offload starts when the measured tab passes `memLimitMB` (default 500 MB). If it can't get under the limit, the feeds need that much: the guard says so and waits 30 minutes, or until the tab grows another 100 MB. Where memory can't be measured (an ordinary tab, a hosted wall), an offload runs every `offloadEveryMin` (default 60). Settings → Memory offload also has **Offload memory now**.

Around the tiles:
- **Load queue** (`requestMount`, `pumpQueue`): feeds start a few at a time, priority feeds first.
- **Bandwidth and quality** (`allocate`, `updateCongestion`, `Tile.sendQuality`):
  - **With the Feed Meter (1.1+),** every feed streams at Settings → "Feeds stream at", whatever its size, unless its Stats sheet sets a quality for that feed alone (`stream.quality`: 480p, 720p or 1080p, over the wall's setting and the priority ceiling; kept in wall.json, so every window follows it). The wall sends `{ type: 'ixg-wall-quality', quality }` into each player, and the extension calls the player's own `setPlaybackQualityRange`, as YouTube's quality menu does. If the stream doesn't offer that level, it takes the nearest one below, and it sets the level again if YouTube drifts off it. Measured: 480p ↔ 720p ↔ 1080p within 15–25 s, both ways, without a reload.
  - **Holding back:** a feed held back by congestion, the laptop or the bandwidth budget is set to 480p; priority feeds are held last.
  - **Without the extension,** quality follows the player's render size, the only lever a page has. Priority feeds, and in scroll mode on-screen feeds, get bigger renders when the budget allows; lowering takes a refresh.
- **Performance governor** (`updatePerf`): sustained high CPU or memory (laptop telemetry), or the browser's own CPU-pressure signal, sheds boosts and postpones refreshes. Hosted, only the browser's signal is available.

YouTube embed limits, measured on the wall laptops:
- Quality requests from the page (`setPlaybackQuality`, `vq`) are ignored. Quality follows render size, and only upward, with a 480p floor. Inside the player, `movie_player.setPlaybackQualityRange(q, q)` works, which is what the Feed Meter uses.
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

- **Every window shares one wall.** The page keeps a local copy (localStorage) for when the backend is offline, but the server's `wall.json` is authoritative. When another window saves, the server broadcasts `wall`, and other pages fetch the new wall and take it in place (`pullRemoteWall`): tiles are keyed by feed id, so added feeds start, removed ones stop, and renames, reordering, priority and settings apply while the other players play on. A session switch rebuilds the wall. Only if the fetch fails is a reload offered.
- **The wall checks for the Feed Meter before starting feeds.** On load it fetches `chrome-extension://<id>/manifest.json` (web-accessible, fixed ID). If that fails, the install popup holds the feeds back until the extension appears or the operator continues without it.
- **The Feed Meter talks only to the page that asks.** The wall sends `ixg-wall-hello` into each of its player frames; the extension in that frame answers to that origin only, every 2 s, with `ixg-meter` reports. The wall accepts a report only from the tile's own frame and origin, and range-checks every field.
- **Google credentials can belong to anyone, and nothing is built in** (`backend/google-credentials.js`). The key and the OAuth client come from Settings or the environment (`YOUTUBE_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID/_SECRET`), from any Google Cloud project. Each is checked with Google before it replaces a working one:
  - **Key:** one call to `i18nLanguages` (1 unit). Google calling it invalid refuses it. A restriction or a disabled API is saved with the fix, because that's changed in Google Cloud, not by changing the key.
  - **OAuth client:** the token endpoint with a made-up code (`invalid_grant` means the ID and secret are right; `invalid_client` means they're wrong), then the sign-in page with this wall's redirect address. Google's error page carries the reason in `authError`, a base64 protobuf (`readAuthError()`), e.g. `redirect_uri_mismatch`. A refused client isn't saved; an unregistered address is saved with the exact URI to add, and **Check again** re-runs the check.
- **Channel sign-ins live on the server**, one refresh token per channel in `secrets.json`. Any number of channels can sign in with the client. Every 5 minutes `liveBroadcasts` asks each channel which feeds it owns; each poll reads `liveStreams` once per channel with feeds. Pages see only `{ client, channels: [{ id, title, status, feeds }], videos: { id: health… } }`. The stream key (`cdn.ingestionInfo`) is never requested. A sign-in Google stops honouring stays listed as expired until it signs in again or out. A different client ID signs every channel out, because their sign-ins belong to the old client.
- **The YouTube key goes in, never out.** It reaches the server only through `POST /api/youtube/key` and lives in `secrets.json`. Pages learn `{ set, source, last4 }`. Older walls that kept the key in `wall.json` are migrated on startup.

## HTTP API

Signed-in only when a password is set; changes also need the `X-IXG-Wall: 1` header and a same-site `Origin`.

**Roles.** A password sign-in is an admin; a user link is a user. Without a password, every request is an admin's. Users are refused (403) by `handleApi` on `/api/youtube/key`, `/api/youtube/oauth/*`, `/api/links*` and `/api/wall-browser`. Their YouTube state (`youtubeFor()`, on `/api/youtube` and the event stream) carries the numbers and each feed's ingest, but no key info beyond `{ set }`, no OAuth client, channels or redirect address, and no Google error text. A user's wall save keeps the admin's `ytPollSec`, `memLimitMB` and `offloadEveryMin`. Revoking a link ends its sessions on their next request and closes their event streams. The page hides `[data-admin-only]` for users, but that is only tidiness: the server enforces all of it.

| Method & path | What |
|---|---|
| `GET /healthz` | `{ ok: true }`, no sign-in; for load balancers and `update.sh` |
| `POST /api/login` · `POST /api/logout` | sign in as an admin (`{ password }`) / out |
| `GET /join#token` · `POST /api/join` | a user link: the page posts `{ link }` and gets a user session. The token is after the `#`, so it never reaches server logs |
| `GET /api/links` · `POST /api/links` · `POST /api/links/revoke` | admins: list (with each link's address), generate `{ name, days }` (0 = until revoked), revoke `{ id }` |
| `GET /api/config` | `{ hosted, auth, role, linkName, ytKey }`: the page adapts its UI to this |
| `GET /api/wall` · `PUT /api/wall` | the wall `{ version, wall: { settings, streams } }` |
| `GET /api/telemetry` | Server-Sent Events stream (see above) |
| `GET /api/youtube` · `GET /api/youtube/history?id=` | latest audience numbers · one feed's 24 h series (`total` for the wall) |
| `POST /api/youtube/key` | `{ key }`: checked with YouTube, then saved; `""` removes it. Answers `{ ytKey, check }`, or 400 if Google calls it invalid |
| `POST /api/youtube/oauth/client` | `{ clientId, clientSecret }`: checked with Google, then saved; empty removes it. Answers `{ ingest, check }`, or 400 if Google refuses it |
| `POST /api/youtube/oauth/check` | check the saved client with Google again |
| `GET /api/youtube/oauth/start` · `GET /api/youtube/oauth/callback` | Google sign-in round trip (popup) that adds or renews a channel; the callback checks a one-time `state` |
| `POST /api/youtube/oauth/signout` | `{ channelId }` signs that channel out, `{}` every channel; revokes the tokens at Google |
| `GET /api/status` | latest telemetry + wall-window status |
| `POST /api/wall-browser` | `{ action: launch \| relaunch, decode }` (laptop only) |

## Files on disk (data folder)

| File | Holds |
|---|---|
| `wall.json` | feeds and settings, with a version number |
| `secrets.json` | YouTube key, OAuth client, one refresh token per signed-in channel, user links, session-signing key (mode 600) |
| `youtube-history.json` | 24 h audience history, quota used today |
| `backend.json`, `wall-profile/` | laptop only: wall-window decode mode, pid, browser profile |
