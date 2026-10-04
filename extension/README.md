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

With it, the wall's header shows **Feeds need** (all bitrates added up) and **Feeds getting** (all data received), both measured. On the laptop it also shows **PC download** (the whole computer), so the difference reveals other traffic on the PC. Without it, "Feeds need" falls back to typical bitrates, marked Estimated.

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

- **Where it runs:** only inside YouTube embedded players (`youtube.com/embed/*`, `youtube-nocookie.com/embed/*`). It doesn't run on YouTube.com itself or on any other site.
- **Who it reports to:** only a page that asks first. The wall sends `{ type: 'ixg-wall-hello' }` into its own players, and the reports go back to that page's origin alone.
- **What it reads:** sizes and timings of the video downloads. It doesn't read video content, cookies or account data, and it stores and sends nothing anywhere else.

## Maintenance

It relies on YouTube player internals (`getStatsForNerds`, `getVideoStats`) and on googlevideo allowing resource timing. If YouTube changes them, readings go blank, and the wall falls back to estimates rather than breaking. Check it with `node tools/check-feed-meter.js http://localhost:8095` against a test wall (see DEVELOPMENT.md).

Bump `version` in `manifest.json` when you change `meter.js`. Walls then tell browsers with the older version to update. On your own machine, reload it in `chrome://extensions`.
