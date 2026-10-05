# Developing IXG Wall

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit, and [DEPLOY.md](DEPLOY.md) for running it on a server.

## Setup

You need Node 22 or newer, Git, and Chrome or Edge.

```bash
git clone https://github.com/VamsiVilla001/ixg-wall.git
cd ixg-wall
npm test           # no npm install: the app has no dependencies
```

## Running it locally

| Command | What it runs |
|---|---|
| `npm start` | laptop mode on http://localhost:8080, backend only; open it in any browser |
| `npm run wall` | laptop mode plus the managed wall window |
| `npm run dev:hosted` | the hosted website, with sign-in. First `cp .env.example .env`; it serves http://localhost:8090 |
| `npm test` | backend smoke tests, link parsing, and playback sync regressions. They use throwaway data folders and fake players and never call YouTube. |
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
  - Anything that touches the Google integrations or the wall computer is admin-only: add its path to the role check at the top of `handleApi`, and keep its details out of `youtubeFor()` for users.
  - Anything that changes state must check `trusted(req)`.
  - Add a case to `test/server.test.js`.
- **Laptop-only or hosted-only UI:** mark the element `data-laptop-only` or `data-hosted-only`; the stylesheet hides it in the other mode. In `app.js`, branch on `server.hosted`.
- **Secrets:** anything a browser must not see belongs in `backend/secrets.js`, never in the wall's settings, because every signed-in page downloads the wall.
- **Google credentials are never built in.** The API key and the OAuth client belong to whoever runs the wall: they come from Settings or the environment, through `backend/google-credentials.js`, which checks them with Google before saving. Code that calls Google takes the key, tokens and endpoints from that module (`GOOGLE`), so tests can point everything at a fake Google (`test/google.test.js`).

## Conventions

- **No runtime dependencies.** Node's standard library on the server, plain browser JavaScript in the page. This keeps a laptop copy and the server trivial to run: nothing to install or build. Discuss before adding one.
- **Comments say why, not what.** Many choices come from measurements on the wall laptops, such as the decode benchmark, YouTube embed limits and quality behaviour. Keep those comments when editing.
- **Never invent numbers.** Every figure on the wall is tagged MEASURED, MODELED, ESTIMATED or N·A, and the wall says plainly when it doesn't know something.
- **Operator-facing text** names what happened and what to do, in plain words, for example "Key restricted to other IP addresses: allow this server's public IP…".

## Design rules (IXG Design System)

IXG Wall follows [ixg-design-system](https://github.com/praveen-anne/ixg-design-system) in its dark console theme. The native CSS adapter is documented in [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md).

- Space Grotesk 500 for display and all figures, with tabular numerals; Manrope 400/600 for UI and labels.
- Use semantic `--ixg-*` tokens for surfaces, actions, borders and operational states.
- Purple marks primary actions, active tabs and focus. Operational states use a dot and a text label.
- Controls have 2px corners; containers 3px; micro elements 1px. No elevation or entrance animation.
- Destructive controls are outlined. Stats stay beside or beneath the video.
- Buffering and low buffer remain faults; paused states are degraded. Keep measured, modeled, estimated and unavailable readings identified.

## Releasing

1. Run `npm test`, then try the change in a browser in each mode it touches.
2. Commit and push to `main`.
3. **Website:** on the server, run `sudo bash /opt/ixg-wall/deploy/update.sh`, then reload open walls.
4. **Laptops:** pull or copy the new project folder, then restart the wall (`Start IXG Wall.cmd`).
