# Developing IXG Wall

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit, and [DEPLOY.md](DEPLOY.md) for running it on a server.

## Setup

You need Node 22 or newer, Git, and Chrome or Edge.

```bash
git clone https://github.com/VamsiVilla001/ixg-wall.git
cd ixg-wall
npm install        # only needed to build the exe; the app itself has no dependencies
npm test
```

## Running it locally

| Command | What it runs |
|---|---|
| `npm start` | laptop mode on http://localhost:8080, backend only; open it in any browser |
| `npm run wall` | laptop mode plus the managed wall window |
| `npm run dev:hosted` | the hosted website, with sign-in. First `cp .env.example .env`; it serves http://localhost:8090 |
| `npm test` | backend smoke tests, link parsing, and playback sync regressions. They use throwaway data folders and fake players and never call YouTube. |
| `npm run build` | `dist\IXG Wall.exe` (Windows) |
| `node tools/check-feed-meter.js http://localhost:8095` | starts a throwaway headless Chrome with the Feed Meter extension against a test wall, and prints what every feed reports |

**Never test against the real wall.** Laptop mode keeps its data in `%LOCALAPPDATA%\IXG Wall`, the operators' real feeds. For any experiment, run a separate instance:

```bash
PORT=8095 IXG_DATA_DIR=./.data node server.js
```

`.data/` and `.env` are git-ignored. Test feeds saved into the real `wall.json` would also stop operators' browser walls from migrating.

**Restart the backend after changing server code.** Edits to `server.js` or `backend/` only take effect after a restart; changes in `public/` only need a page reload. On a laptop, restart with `npm start`, not `--open`, or you get a second wall window.

## Where to make changes

- **A new setting on the wall:** add it to `DEFAULT_SETTINGS` (and `LIMITS` if numeric) in `public/app.js`. Give its input `data-setting="name"` in `index.html`, and handle side effects in `applySetting`. It's saved with the wall automatically.
- **A new server setting:** read it in `backend/config.js` only, and document it in `.env.example` and DEPLOY.md.
- **A new API endpoint:** add it in `handleApi` in `server.js`.
  - Endpoints are signed-in by default.
  - Anything that changes state must check `trusted(req)`.
  - Add a case to `test/server.test.js`.
- **Laptop-only or hosted-only UI:** mark the element `data-laptop-only` or `data-hosted-only`; the stylesheet hides it in the other mode. In `app.js`, branch on `server.hosted`.
- **Secrets:** anything a browser must not see belongs in `backend/secrets.js`, never in the wall's settings, because every signed-in page downloads the wall.

## Conventions

- **No runtime dependencies.** Node's standard library on the server, plain browser JavaScript in the page. This keeps the exe self-contained and the server trivial to deploy. Discuss before adding one.
- **Comments say why, not what.** Many choices come from measurements on the wall laptops, such as the decode benchmark, YouTube embed limits and quality behaviour. Keep those comments when editing.
- **Never invent numbers.** Every figure on the wall is tagged MEASURED, MODELED, ESTIMATED or N·A, and the wall says plainly when it doesn't know something.
- **Operator-facing text** names what happened and what to do, in plain words, for example "Key restricted to other IP addresses: allow this server's public IP…".

## Design rules (SKWAD design system, Live mode)

The wall follows [SKWAD](https://skwad-design.vercel.app) in Live (dark) mode only. The broadcast team expects these rules followed exactly:

- **Three voices that never mix:**
  - Anybody 800 for state words and hero moments.
  - Manrope for UI: 500 body, 700 section titles, 800 titles.
  - JetBrains Mono for every number and label.
- **Metric block:** a mono 600 10px uppercase label with .1em letter spacing in muted ink, then a mono 500 value. Values come in three sizes: lg 32px, md 22px, sm 16px.
- **Deltas:** mono 600 11px, coloured by sign: + is ok, − is danger.
- **Provenance:** plain mono 600 9px uppercase ink-4 text, not a pill.
- **Hierarchy comes from weight contrast, not pale ink.**
- **Stats never overlay the video.** They sit in the side card beside it or the info bar under it.
- **Buffering and low buffer are always red.** Only states that resolve themselves, such as paused, are amber.

## Releasing

1. Run `npm test`, then try the change in a browser in each mode it touches.
2. Commit and push to `main`.
3. **Website:** on the server, run `sudo bash /opt/ixg-wall/deploy/update.sh`, then reload open walls.
4. **Laptops:** run `npm run build` and hand out the new `dist\IXG Wall.exe`.
