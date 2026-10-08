# IXG Wall

A YouTube live monitoring wall for 20–30 feeds, built on the [IXG design system](https://github.com/praveen-anne/ixg-design-system) (dark console theme).

It runs two ways from the same code:
- **As a website:** on a server with a sign-in. See **[DEPLOY.md](DEPLOY.md)** for AWS.
- **On a wall laptop:** from the project folder with Node, described below.

For measured per-feed bitrate, bandwidth and audio levels, and for the viewing computer's CPU and memory on the website, install the **[IXG Wall Feed Meter](extension/README.md)** Chrome extension on each wall computer. It also takes **source screenshots**: from a feed's Stats sheet, **Capture source screenshot** saves a PNG of the feed's own YouTube page (player, title, channel, LIVE, watching-now count) to `Downloads/IXG-Wall/Screenshots`, named `{Account}_{Title}_{CCV}CCV_{date_time}.png`. It also takes them **automatically** (Settings → Source screenshots, on by default): each time a feed reaches a **new PCV** (its watching-now count beats the highest read so far in that broadcast; at most once every 2 or 4 minutes per feed) and when a feed's broadcast ends, when the screenshot shows YouTube's total views. **On a laptop the backend takes all of them itself**, manual and automatic, in a hidden headless Chrome at below-normal priority: no window pops up and focus never moves, so the wall and the rest of the PC are left alone. It saves them in a folder named after the wall's current session (`Downloads/IXG-Wall/Screenshots/<session name>/`), so two walls or two events never mix, and names them language first, from the feed's `[HINDI]`-style tag: `[Hindi] - BMSD 2026 Semi-Finals Day 1 - 154,337 PCV - 2026-10-08 15-52.png`, `… - 543,460 Views - END - …` at the end. With Slack set up (Settings → Source screenshots → Post screenshots to Slack) each one is posted to a channel as it's saved. A hosted wall's server does the same once Chrome is installed on it (DEPLOY.md), with Slack carrying the files out. The extension takes them only where the server has no Chrome, with its own names (`_PEAK_` / `_END_`), and doesn't post them.

To work on the code, read **[DEVELOPMENT.md](DEVELOPMENT.md)** and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Run it on a laptop

Needs Node 22.9+ and Chrome or Edge. There's nothing to install or build: the app has no dependencies.

- **`Start IXG Wall.cmd`** (double-click) or **`npm run wall`**: starts the backend and opens the wall in its own window. Keep the black backend window open while the wall runs.
- Starting it again while the wall runs just brings back the wall window.
- **Sign-in (optional):** copy `local.env.example` to `local.env` beside the launcher and set `IXG_PASSWORD` (8+ characters). The wall then asks for it: whoever signs in with it is an admin, and admins hand out **user links** (Settings → User links) to everyone else. `local.env` is never committed.
- **`npm start`**: backend only. Open http://localhost:8080 in any browser.
- **Two sessions at once:** **`Start IXG Wall (second).cmd`** runs a second, independent wall on http://localhost:8081 with its own data folder (`%LOCALAPPDATA%\IXG Wall 2`) and its own wall window. It has its own settings, so paste the YouTube API key there once (Settings → YouTube API); a channel sign-in on it needs `http://localhost:8081/api/youtube/oauth/callback` added to the Google OAuth client. Each wall polls YouTube on its own, so the key's quota is shared between them, and a feed on both walls is screenshotted (and posted to Slack) by both. Any further wall is the same with another `PORT` and `IXG_DATA_DIR`.
- Every window shares one wall. Feeds and settings are kept in `%LOCALAPPDATA%\IXG Wall\wall.json`. The YouTube API key is kept apart, in `secrets.json`, and is never sent back to a browser.
- To update a laptop, copy or pull the new project folder and restart the wall.

## What the backend does

- **Serves the wall.** YouTube embeds won't play from `file://` pages.
- **Runs the wall window.** It gets its own Chrome/Edge profile and app mode (no tab strip), with no throttling when other windows cover it. The window is restarted within ~3 s if the browser crashes; closing it on purpose leaves it closed.
- **Measures the laptop** every 2 s and streams it to the wall: CPU, memory, real download/upload on the busiest network adapter, and the browser's load on the GPU video and 3D engines.
- **Polls the YouTube Data API** for every feed, every 30 s by default (optional; paste a key under **Settings → YouTube API**, which also sets the interval). One poll serves every open window: every 30 s uses about 3,000 of the daily 10,000 quota units for up to 50 feeds. Besides viewers, likes, views and comments it reads each video's broadcast state (live, scheduled, ended), privacy, whether embedding is allowed, HD/SD and live chat, at no extra quota. It keeps a 24-hour viewer history in `%LOCALAPPDATA%\IXG Wall\youtube-history.json` for each feed's analytics: peak, average, lowest, 10-minute trend, likes and views per hour, like rate, channel subscribers.
- **Tracks each broadcast's PCV** (peak concurrent viewers, `pcv.json`): at every poll the current CCV, the highest CCV read in that broadcast and when, and the last update. The PCV never goes down while the broadcast lasts; a hidden or missing count is never taken as zero and never touches it; a failed poll resets nothing and the next one waits longer (twice the interval, then 4× … up to 5 minutes; 15 minutes when the daily quota is used up). It survives a restart. Because it's sampled every 30 s, a spike between two reads can be missed, so the wall calls it **PCV · sampled** and never presents it as YouTube Studio's. For broadcasts a signed-in channel owns, **YouTube Studio's own PCV** (YouTube Analytics' `peakConcurrentViewers`) is read too and kept beside it, never in place of it; the stream-end Slack post gives it first. A feed's Stats sheet shows current CCV, both PCVs, the peak's time, the last update and the stream status (Waiting for live data / Live / Ended).
- **Reads YouTube Studio's audience** for feeds owned by a signed-in channel (Settings → YouTube API → Channel sign-in): YouTube Analytics' concurrent viewers for every minute since the broadcast went live. That feed's viewer graph and its peak, average and lowest then start at go-live, not when the wall started watching. YouTube has those minutes about 2 minutes after they happen (measured), so the wall's own readings fill that last stretch. Feeds of other channels only have the wall's readings: YouTube shows a broadcast's audience history to its owner alone.

## Benchmark: the lowest-spec wall laptop

Lenovo IdeaPad Gaming 3 (Ryzen 5 4600H, Radeon integrated graphics, GTX 1650, 16 GB), Chrome 154, live news feeds at 480p, measured on 2026-10-03:

| Setup | Feeds playing | Dropped frames | Chrome CPU |
|---|---|---|---|
| GPU (hardware) decode | 24/24 | 3.9–6.7% | 1.4–2.9 cores |
| **Software decode (default)** | **30/30** | **0%** | 4.7 cores (39% of the laptop) |
| Chrome forced onto the GTX 1650 | 17/24 | — | — |

On this laptop the stutter comes from the Radeon video engine juggling many decodes, so the wall window decodes on the CPU. Change this under **Settings → Laptop & rendering → Video decoding**; the wall window restarts with the new mode.

## Layouts: preset PIP layouts and your own

The bar at the bottom right of the wall picks how feeds are arranged.
- **Six quick layouts** sit on the bar: one feed, two stacked, two side by side, two over one, two beside one tall, and 2 × 2.
- **"…"** opens 28 more, including one big beside two, a big feed over a strip, 3 × 3, two big over eight and 4 × 4.
  - **Custom layout** opens a builder: pick a grid of up to 6 × 6, then drag across squares to draw each box.
  - **Columns, scroll** and **Fit all** go back to the plain grids.
- **A layout applies to every feed.** It repeats one screen-high page at a time, and the wall scrolls a page at a time. For example, 2 × 2 with 10 feeds gives three pages: 4, 4 and 2. A part-filled last page is only as tall as its feeds: on an even grid (2 × 2, 3 × 3 …) its feeds keep the grid's box size and the last row widens to fill the width, so those 2 sit side by side on a half-height page. A PIP shape keeps its first boxes, cut below the lowest. A wall that fits on one part-filled page spreads its feeds over the screen instead (3 feeds in 2 × 2 are 2 over 1).
- **Each page's first feed takes its biggest box.** Drag a feed there to make it the main one.
- **Drag any feed to a new place,** in every layout. Press on its picture or its bar and move it:
  - The box follows the pointer, and the others slide out of its way.
  - Holding it at the wall's top or bottom edge scrolls to other pages.
  - **Esc** puts it back. A plain click still picks that feed's audio.
  - The new order is saved with the wall.
- **Changing layout never reloads a player.**

## Timelines: rewind one feed or the whole wall

Every live feed whose broadcast allows YouTube's live rewind (DVR) can be moved back.
- **Each tile** has a seek bar along the top of the bar under its video. Hover to see the moment, click or drag to move just that feed. It shows **Own −2:30** until you press **Jump live** on it.
- **Viewers along the bar.** With a YouTube API key, hovering a seek bar draws the feed's watching-now count over the bar's span (the wall total on the wall timeline), with the peak and low marked and the count at the pointer in the label. Set the bars to **All** to see as far back as YouTube's live rewind keeps (the backend records up to 24 h; a stream is recorded from the moment its feed is on the wall).
- **The wall timeline** under the wall moves every feed to the same moment, by YouTube's time stamp on the frame. Use it to replay one moment from every POV together.
  - Pause, −10 s and +10 s.
  - **Last 5 min … All** sets how much the bars cover.
  - **Go live** brings every feed back to live.
- While the wall is moved back, the feeds stay in sync with each other, as they do at live. A paused wall raises no alerts.
- Feeds with DVR off stay live, and the timeline says which ones aren't following and why.
- It's per window: rewinding on one screen doesn't move the others, and a reloaded wall starts live.

## Keeping playback smooth

- **Feeds load a few at a time**, priority feeds first, so startup and refreshes never hit the network or CPU all at once.
- **Small drift is closed by playing at 1.25×** until the feed is back at its usual lag (8 s of drift closes in ~35 s), instead of a visible jump. Larger drift still jumps.
- **If a jump doesn't get any closer**, the live edge itself moved, and the wall accepts the new lag instead of jumping and refreshing in a loop.
- **When the laptop is busy** (CPU ≥ 85% or memory ≥ 93% for 8 s, or Chrome reports serious CPU pressure), the wall sheds priority boosts one at a time, starts feeds one at a time, and postpones scheduled refreshes. Everything comes back one step per calm minute.
- **A feed whose picture freezes** while still reporting "playing" is refreshed.
- **A playing feed is otherwise left alone.** The scheduled hard refresh is off by default (Settings → Hard-refresh each feed every).
- **A feed whose encoder stopped** while YouTube keeps the broadcast on air (the channel sign-in sees this) is held rather than refreshed over and over: the tile says **No ingest** with the time it stopped, the wall tries the player again every 5 minutes, and it restarts the moment the encoder sends again.
- **A broadcast YouTube says has ended** keeps playing in its player (the recording, as YouTube serves it); the tile's chip says **Ended** with the end time, its seek bar turns grey, and it is never an alert. YouTube's word comes from the API key's poll, or from the channel sign-in, which asks the moment the encoder stops sending.
