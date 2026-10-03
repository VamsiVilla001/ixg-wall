# IXG Wall

A YouTube live monitoring wall for 20–30 feeds, built on the SKWAD design system (Live mode).

## Run it

Double-click **`dist\IXG Wall.exe`**. It starts the backend and opens the wall in its own window. Keep the black backend window open while the wall runs. The exe is self-contained: copy it to any Windows laptop with Chrome or Edge; Node isn't needed there.

- Double-clicking it again while the wall runs just brings back the wall window.
- `IXG Wall.exe --serve`: backend only. Open http://localhost:8080 in any browser.
- Every window shares one wall. Feeds and settings are kept in `%LOCALAPPDATA%\IXG Wall\wall.json`, so the exe and the `node` version see the same wall.

From the project folder (needs Node 22+): `Start IXG Wall.cmd` or `npm run wall` opens the wall, and `npm start` serves it only.

## Build the exe

`npm install` once, then `npm run build`. It writes `dist\IXG Wall.exe` (~77 MB, mostly the embedded Node runtime). It bundles `server.js` and `backend\`, and embeds `public\` and the telemetry agent. Rebuild after changing any of them.

The exe is unsigned. Copied to another laptop over the internet, Windows SmartScreen may ask once: click **More info → Run anyway**.

## What the backend does

- **Serves the wall.** YouTube embeds won't play from `file://` pages.
- **Runs the wall window.** It gets its own Chrome/Edge profile and app mode (no tab strip), with no throttling when other windows cover it. The window is restarted within ~3 s if the browser crashes; closing it on purpose leaves it closed.
- **Measures the laptop** every 2 s and streams it to the wall: CPU, memory, real download/upload on the busiest network adapter, and the browser's load on the GPU video and 3D engines.
- **Polls the YouTube Data API** for every feed, every 30 s by default (optional; paste a key under **Settings → YouTube API**, which also sets the interval). One poll serves every open window: every 30 s uses about 3,000 of the daily 10,000 quota units for up to 50 feeds. Besides viewers, likes, views and comments it reads each video's broadcast state (live, scheduled, ended), privacy, whether embedding is allowed, HD/SD and live chat, at no extra quota. It keeps a 24-hour viewer history in `%LOCALAPPDATA%\IXG Wall\youtube-history.json` for each feed's analytics: peak, average, lowest, 10-minute trend, likes and views per hour, like rate, channel subscribers.

## Benchmark: the lowest-spec wall laptop

Lenovo IdeaPad Gaming 3 (Ryzen 5 4600H, Radeon integrated graphics, GTX 1650, 16 GB), Chrome 154, live news feeds at 480p, measured on 2026-10-03:

| Setup | Feeds playing | Dropped frames | Chrome CPU |
|---|---|---|---|
| GPU (hardware) decode | 24/24 | 3.9–6.7% | 1.4–2.9 cores |
| **Software decode (default)** | **30/30** | **0%** | 4.7 cores (39% of the laptop) |
| Chrome forced onto the GTX 1650 | 17/24 | — | — |

On this laptop the stutter comes from the Radeon video engine juggling many decodes, so the wall window decodes on the CPU. Change this under **Settings → Laptop & rendering → Video decoding**; the wall window restarts with the new mode.

## Keeping playback smooth

- **Feeds load a few at a time**, priority feeds first, so startup and refreshes never hit the network or CPU all at once.
- **Small drift is closed by playing at 1.25×** until the feed is back at its usual lag (8 s of drift closes in ~35 s), instead of a visible jump. Larger drift still jumps.
- **If a jump doesn't get any closer**, the live edge itself moved, and the wall accepts the new lag instead of jumping and refreshing in a loop.
- **When the laptop is busy** (CPU ≥ 85% or memory ≥ 93% for 8 s, or Chrome reports serious CPU pressure), the wall sheds priority boosts one at a time, starts feeds one at a time, and postpones scheduled refreshes. Everything comes back one step per calm minute.
- **A feed whose picture freezes** while still reporting "playing" is refreshed.
