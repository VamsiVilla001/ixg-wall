# IXG Wall Feed Meter (Chrome extension)

The wall page can't see inside its YouTube players, because each one is an isolated YouTube frame. This extension runs inside each player and reports, every 2 s, what that player is really doing:

| Reading | How it's measured |
|---|---|
| **Bitrate** (Mbps) | bytes received ÷ seconds of video downloaded, over 30 s (video plus audio) |
| **Receiving** (Mbps) | bytes received per second over 30 s |
| **Connection speed** | the player's own bandwidth estimate (YouTube's Stats for nerds "Connection Speed") |
| **Headroom** | connection speed ÷ bitrate. Below 1.2× is red: stalls are coming |
| **Resolution, fps, formats** | the video element, and YouTube's format codes |
| **Latency mode** | Normal / Low / Ultra-low, as YouTube's player reports it |
| **Dropped frames** | the video element's playback quality counters |
| **Stereo audio** (dBFS) | decoded audio from `captureStream()`, analysed locally at 10 updates per second; RMS bars and sample-peak markers, −60 to 0 dBFS |

Version 1.2.0 adds an **L/R audio meter to the left of each video**. It measures audio before the player's mute and volume controls, so selecting one feed to hear does not stop metering the others. A mono track is displayed on both bars when the browser identifies it as mono. The analysis branch is silent and never changes player volume, mute or playback.

The rail shows **N/A** without compatible readings, **Enable** when the browser suspends its audio analyser, and **Idle / End** when playback pauses or the broadcast ends. For Enable, interact with the YouTube player, or use the managed wall window, which already permits autoplay. Browser or cross-origin restrictions can make readings unavailable; the wall never substitutes invented levels. Reload the updated extension in `chrome://extensions` (or `edge://extensions`) and refresh the wall to use it.

Since 1.1.0 it also **sets each player's quality** to the wall's "Feeds stream at" setting (480p, 720p or 1080p), the way YouTube's own quality menu does. The wall page can't do this itself: embedded players ignore quality requests from the page and size quality to the player. With the extension, every feed streams at the chosen quality whatever its size on screen, and changes apply within about 15 s without a refresh.

With it, the wall's header shows **Feeds need** (all bitrates added up) and **Feeds getting** (all data received), both measured. On the laptop it also shows **PC download** (the whole computer), so the difference reveals other traffic on the PC. Without it, "Feeds need" falls back to typical bitrates, marked Estimated.

## Capture Source Screenshot (1.3.0)

Evidence of a feed from its **own YouTube page**, not from the wall: the player, the title, the channel name, the LIVE badge and YouTube's own **"N watching now"** count, as YouTube shows them. Open a feed's stats sheet (**Stats** on the tile) and press **Capture source screenshot**.

What happens: the wall asks the extension through one of its players (`courier.js`, since a web page can't talk to an extension's worker directly). The worker (`capture.js`) opens the feed's watch page in a small muted window **behind** the wall, waits for the page to load, then for its player, title and channel, then for the watching-now count (up to 20 s, since it renders late), lets it settle, screenshots the window, crops the block that holds those parts, saves the PNG and closes the window. The sheet shows each step (`Opening source…`, `Waiting for source data…`, `Waiting for CCV…`, `Capturing…`, `Screenshot saved: …`) and the reason when it fails (`Source video unavailable: …`, `Source page failed to load`, `Viewer count could not be detected: saved as CCV-NA`).

- **Files:** `Downloads/IXG-Wall/Screenshots/{Account}_{Title}_{CCV}CCV_{YYYY-MM-DD_HHmmss}.png`, e.g. `KRAFTON_INDIA_ESPORTS_BGMI_FINALS_124382CCV_2026-10-05_205215.png`; `CCV-NA` when YouTube shows no count (a recording, or a count that never appeared). Characters Windows refuses are dropped. Nothing is drawn onto the picture: the count in the file is the one YouTube displayed.
- **One at a time.** A second press while one runs is refused, on the page and in the worker.
- **The window stays behind the wall.** If the browser won't draw it there, it's brought forward for the shot and the wall gets focus straight back. Never more than one window is left open: it closes on success and on failure.
- **Platforms:** YouTube today (`source-youtube.js`: where the parts are, what to wait for). Another platform is one more such file; the workflow doesn't change. Storage is `Storage` in `capture.js`: the browser's Downloads folder today, with room for a native helper that writes into a production folder.
- **Permissions** this needs, all new in 1.3.0: `tabs` (open, mute and close the source window), `scripting` (read the source page), `downloads`, and the `<all_urls>` host permission, because Chrome lets an extension screenshot a tab only with that or with a click on the extension's own icon, which the wall has no way to give. Chrome words it as "read and change all your data on all websites"; the extension reads the YouTube watch page it opened and nothing else (its content scripts still run only inside embedded players).

## Install: the wall asks for it

When the wall opens in a browser that doesn't have the extension, a popup appears **before any feed starts**:

1. **Download extension.** The wall serves it from its own address, `/extension/ixg-wall-feed-meter.zip`. Unzip it to a folder you'll keep.
2. **Open `chrome://extensions`** (Edge: `edge://extensions`) and turn on **Developer mode**. Web pages aren't allowed to open that address, so the popup has a Copy button.
3. **Click Load unpacked** and choose the unzipped **IXG Wall Feed Meter** folder.

The popup checks every 3 s and closes by itself as soon as the extension appears, then the wall starts its feeds. **Continue without it** starts the wall with estimated bitrates; "Don't ask on this computer for 24 hours" stops the popup coming back on every reload.

When the wall later ships a newer version, a banner says so, with update steps.

Browsers only install extensions from their store, by IT policy, or by hand in developer mode, so a web page can't install it in one click. Two ways to make it smoother:

- **Chrome Web Store (unlisted is fine):** publish the zip. Then set `IXG_EXTENSION_STORE_URL` to its store page, and `IXG_EXTENSION_IDS` to the ID the store gives it. The popup then shows one **Add to Chrome** button.
- **IT policy:** force-install it on managed wall computers (`ExtensionInstallForcelist`), and the popup never appears.

It works in ordinary tabs, the managed wall window, and on the hosted website. If the wall runs from a Chrome shortcut with its own `--user-data-dir` (DEPLOY.md), install it in that profile.

## The fixed ID

`manifest.json` carries a public `key`, so the extension's ID is `knlkonhkiknjnnfgalmkdfadkjaiidfe` on every computer. The wall checks for it by fetching `chrome-extension://knlkonhkiknjnnfgalmkdfadkjaiidfe/manifest.json`, the only file the extension makes visible to pages.

The matching private key isn't in the project. It lives on the development PC at `%LOCALAPPDATA%\IXG Wall\feed-meter-key.pem`, and is only needed to pack a signed `.crx` with this same ID. Keep it safe. Replacing the `key` changes the ID, and the wall would stop recognising existing installs.

## Privacy

- **Where it runs:** inside YouTube embedded players (`youtube.com/embed/*`, `youtube-nocookie.com/embed/*`), and, only while a screenshot is being captured, in the watch page it opened for that (`www.youtube.com`). Not on any other site.
- **Who it reports to:** only a page that asks first. The wall sends `{ type: 'ixg-wall-hello' }` into its own players, and the reports go back to that page's origin alone.
- **Who can set the quality:** only that same page (`{ type: 'ixg-wall-quality', quality }`), and only to one of YouTube's quality levels.
- **What it reads:** sizes and timings of the video downloads, player telemetry, and decoded audio samples for local level analysis. Only RMS and sample-peak levels are reported to the wall; raw audio is never recorded, stored or sent. It doesn't read cookies or account data, and reports go nowhere else.

## Maintenance

It relies on YouTube player internals (`getStatsForNerds`, `getVideoStats`) and on googlevideo allowing resource timing. If YouTube changes them, readings go blank, and the wall falls back to estimates rather than breaking. Check it with `node tools/check-feed-meter.js http://localhost:8095` against a test wall (see DEVELOPMENT.md).

Bump `version` in `manifest.json` when you change `meter.js`. Walls then tell browsers with the older version to update. On your own machine, reload it in `chrome://extensions`.
