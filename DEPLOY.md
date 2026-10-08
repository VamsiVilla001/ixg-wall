# Deploying IXG Wall as a website (AWS)

The hosted wall is the same app the laptops run, started with `IXG_HOSTED=1` on a small Linux server:

- **Sign-in, two roles, no usernames:**
  - **Admin:** the wall password, set on the server. Admins manage the YouTube key, the channel sign-in and user links.
  - **User:** a link an admin generates. Users operate the wall (order, remove and rename feeds, switch sessions, layout, playback). They can't add feeds or change a feed's link, and have no YouTube settings: whether a link ships the YouTube numbers and ingest health is the admin's choice when making it (on by default). Those are read with the admin's key and channel sign-ins, which users never see or change. The server enforces all of this, not just the page.
  - A browser stays signed in for 30 days.
- **YouTube key on the server:** the key is kept server-side and never sent to a browser.
- **No laptop features:** no managed wall window and no laptop telemetry, because the server isn't the screen showing the wall. Drift correction, refreshes, the load queue and the YouTube analytics all work as before.

Video never passes through the server: each browser streams straight from YouTube. The server only serves the page, stores the wall, and polls YouTube for audience numbers, so the smallest instance is enough.

```
viewer's Chrome ──https──► Caddy (HTTPS, port 443) ──► node server.js (127.0.0.1:8080)
      │                                                    └─ /var/lib/ixg-wall: wall, key, history
      └──── video straight from YouTube
```

## What you need

- An AWS account. Use an IAM user with Lightsail or EC2 permissions, **not the root account's access keys**.
- **Recommended:** a subdomain you control, for example `wall.yourcompany.com`. It gets a free HTTPS certificate automatically.
  - No domain yet? See [Option B](#option-b-no-domain-cloudfront-address).
- The project on GitHub (`VamsiVilla001/ixg-wall`).

## Option A: your own subdomain (recommended)

### 1. Create the server

**Lightsail (simplest):**
1. Open Lightsail, choose Create instance, and pick the **Mumbai (ap-south-1)** region.
2. Choose Linux/Unix, OS Only, **Ubuntu 24.04 LTS**, and the **1 GB** plan.
3. **Networking:** create a **static IP** and attach it to the instance, so the address survives restarts.
4. **Networking, IPv4 firewall:** keep SSH (22) and HTTP (80), and add **HTTPS (443)**.

**EC2 alternative:**
1. Launch a `t4g.small` instance with Ubuntu 24.04 and attach an **Elastic IP**.
2. In the security group, allow inbound 22 from your IP only, and 80 and 443 from anywhere.

### 2. Point the subdomain at it

At your DNS provider, add an **A record**: `wall.yourcompany.com` → the static IP. Check it with `nslookup wall.yourcompany.com`.

### 3. Get the code onto the server

SSH in. Lightsail has a browser SSH button. Then:

```bash
sudo git clone https://github.com/VamsiVilla001/ixg-wall.git /opt/ixg-wall
```

If the repository is private, the clone asks for a GitHub username and a token. Create a fine-grained personal access token with read-only **Contents** access to this one repository and paste it as the password.

`update.sh` runs `git pull`, which will ask again. To avoid that, add a read-only **deploy key** instead: in the repo, Settings → Deploy keys. Then clone the `git@github.com:` URL as root.

### 4. Run the setup script

```bash
sudo bash /opt/ixg-wall/deploy/setup.sh --url https://wall.yourcompany.com
```

It installs Node 22 and Caddy, creates the `ixg-wall` service and the HTTPS site, and prints:
- the **sign-in password** (generated; it's shown once and stored in `/etc/ixg-wall/ixg-wall.env`)
- the server's public IP

Running the script again is safe: it keeps your password and settings.

Open `https://wall.yourcompany.com`. Caddy gets the certificate on the first request, which can take a few seconds. Sign in.

### 5. YouTube Data API key

The key can come from anyone's Google Cloud project; nothing is built into the wall.

1. In Google Cloud, edit the key and set **Application restrictions → IP addresses** to the server's IP. Keep **API restrictions** on YouTube Data API v3.
2. On the wall, open Settings → YouTube API, paste the key, and press Save key.
   - The server checks it with YouTube first: a key Google calls invalid is refused and never replaces a working one, and a restriction problem is shown with its fix.
   - The server keeps it in `/var/lib/ixg-wall/secrets.json` and never sends it back to the page.
   - To manage it on the server instead, set `YOUTUBE_API_KEY=` in `/etc/ixg-wall/ixg-wall.env` and run `sudo systemctl restart ixg-wall`. The Settings field then becomes read-only.

### 6. Channel sign-in for ingest health and Studio audience (optional)

This shows how each feed's encoder stream arrives at YouTube: health, resolution, frame rate, and YouTube's warnings such as "bitrate lower than recommended". It also reads YouTube Studio's per-minute audience, so those feeds' viewer graphs start when the broadcast went live. It needs each channel that owns broadcasts on the wall to sign in, read-only. Several channels can be signed in at once (for example KRAFTON INDIA ESPORTS and Rubix IXG), and each feed's ingest comes from the channel that owns it.

The OAuth client can come from anyone's Google Cloud project; nothing is built into the wall.

1. In Google Cloud (the same project as the API key is fine), enable **YouTube Data API v3** and **YouTube Analytics API** under **APIs & Services → Library**, then open **Google Auth Platform** and set up the consent screen.
   - **User type:** if the channel's Google account is in your company's Google Workspace, choose **Internal**.
   - If you choose **External**, the app starts in *Testing*: only the Google accounts listed under **Audience → Test users** can sign in. Anyone else gets "Access blocked: … has not completed the Google verification process" (Error 403: access_denied). Add the account each channel signs in with (for a brand channel, the person's own Google account that manages it), and Google also expires these sign-ins every 7 days.
   - To stop the 7-day expiry, press **Publish app** under **Audience**. The read-only YouTube scope is "sensitive", so until Google verifies the app, channels see "Google hasn't verified this app" and continue through **Advanced → Go to … (unsafe)**.
2. Under **Credentials → Create credentials → OAuth client ID**, choose type **Web application**, and add this authorised redirect URI:
   `https://wall.yourcompany.com/api/youtube/oauth/callback`. The wall shows the exact address under Settings → YouTube API → Channel sign-in.
3. On the wall, paste the client ID and secret into Settings → YouTube API → **Channel sign-in** and press Save client.
   - **The server checks the client with Google first.** A wrong ID or secret is refused. If the redirect URI isn't registered yet, the wall says exactly which address to add: add it in Google Cloud, then press **Check again**.
   - Or set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in `/etc/ixg-wall/ixg-wall.env` and restart.
4. Press **Sign in with Google** and sign in with a channel's account. For each further channel, press **Add another channel**.
   - The server keeps each sign-in in `secrets.json`; no browser ever receives it, and the stream keys are never requested.
   - Each channel can be signed out on its own. If Google stops honouring a sign-in, the channel shows **Sign in again**.
   - Leave **YouTube Analytics** ticked on Google's consent page. If YouTube refuses a channel's Analytics, the channel shows the reason (and **Sign in again** when the sign-in itself lacks it); ingest health keeps working meanwhile. Channels signed in before the wall asked for it keep working: YouTube accepts the read-only YouTube permission for these reports.
   - Quota: each poll uses 1 unit per signed-in channel with feeds on the wall, from the OAuth client's project. Settings shows the daily estimate.

### 7. Source screenshots on the server (optional)

The server takes the source screenshots itself, in a hidden Chrome, exactly as a laptop wall does: at each feed's new PCV and at a stream's end, named language first and saved under `/var/lib/ixg-wall/screenshots/<session name>/` (or `IXG_SCREENSHOT_DIR`). Nobody's browser is involved and nothing ever pops up on an operator's screen. Since the files are on the server, set up Slack (Settings → Source screenshots → Post screenshots to Slack, or `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` in `ixg-wall.env`) so each one is posted to the team as it's taken.

1. Install Chrome on the server: `sudo apt-get install -y chromium-browser` (Ubuntu) or Google's `google-chrome-stable` package. The wall finds it at `/usr/bin/chromium-browser`, `/usr/bin/chromium` or `/usr/bin/google-chrome`; set `IXG_BROWSER=/path/to/chrome` in `ixg-wall.env` for another location.
2. `sudo systemctl restart ixg-wall`. Settings → Source screenshots then says the backend takes them.

Without Chrome on the server, the wall falls back to the Feed Meter in an **admin's** browser (see "Running it day to day"), which opens the feed's YouTube page in a window behind the wall. `IXG_SERVER_CAPTURE=0` forces that fallback.

## Option B: no domain (CloudFront address)

Use this to get an HTTPS address like `https://d111abcdef.cloudfront.net` without a domain. CloudFront serves HTTPS and forwards everything to the server. A secret header stops anyone from bypassing it by opening the server's IP over plain HTTP.

CloudFront needs the origin as a DNS name, not an IP:
- EC2 instances have one: "Public IPv4 DNS" (`ec2-….ap-south-1.compute.amazonaws.com`). Use **EC2** for this option, with an Elastic IP.
- Lightsail instances only have an IP address. With Lightsail, use Option A.

1. Do steps 1 and 3 of Option A. Port 443 doesn't need to be open.
2. Create a CloudFront distribution:
   - **Origin domain:** the instance's Public IPv4 DNS. **Protocol:** HTTP only, port 80.
   - **Viewer protocol policy:** Redirect HTTP to HTTPS. **Allowed HTTP methods:** GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE.
   - **Cache policy:** `CachingDisabled`. **Origin request policy:** `AllViewer`. The wall needs every cookie, header and query string.
   - Create it and note its `https://d….cloudfront.net` address.
3. On the server:
   ```bash
   sudo bash /opt/ixg-wall/deploy/setup.sh --url https://d111abcdef.cloudfront.net --cdn
   ```
   It prints a secret value for the header `X-Origin-Verify`.
4. Add that header in CloudFront: **Origins → Edit → Add custom header**, name `X-Origin-Verify`, value as printed. Requests without it get 403.
5. Do step 5 of Option A (the YouTube key).

The wall's live updates are an event stream. The server pings it every 15 s, inside CloudFront's 30 s origin timeout.

## Running it day to day

| Task | Command (on the server) |
|---|---|
| Update to the latest code | `sudo bash /opt/ixg-wall/deploy/update.sh`, then reload open walls |
| Status / restart | `systemctl status ixg-wall` · `sudo systemctl restart ixg-wall` |
| Live logs | `journalctl -u ixg-wall -f` (Caddy: `journalctl -u caddy -f`) |
| Change the password | Edit `IXG_PASSWORD` in `/etc/ixg-wall/ixg-wall.env`, then restart. Everyone is signed out, users included; their links keep working. |
| Let someone in as a user | Settings → **User links** → name it → **Generate link**, and send them the link. **Revoke** signs out everyone who used it. |
| Back up | `/var/lib/ixg-wall` (wall, key, audience history) and `/etc/ixg-wall`. On Lightsail, enable automatic snapshots. |

Wrong passwords and wrong user links are slowed down, and 10 from one address within 15 minutes lock it out for the rest of the window.

Share the wall password only with admins. Everyone else gets a user link: the sign-in page has an **Admin / User** toggle, and opening a user link signs the browser in by itself.

## The wall laptops

- **Open the wall in Chrome or Edge at the wall's address**, and sign in once per browser profile.
- **Install the IXG Wall Feed Meter extension.** The wall asks for it on first open, with a download from the wall's own address and three steps (`extension/README.md`). Without it, per-feed bitrate is an estimate, and "Feeds getting" isn't available. After an update that changes the extension (the wall says so), download it again and reload it in `chrome://extensions`.
- **Automatic source screenshots** (Settings → Source screenshots) are decided by the server, at each feed's new PCV (its count beats the highest read so far in the broadcast) and when a broadcast ends (that one shows the total views), and taken by the server itself when Chrome is installed on it (step 7 above: hidden, named language first, saved per session, posted to Slack). Without Chrome on the server they're taken by a browser instead: an **admin's** wall with the Feed Meter, which saves them in that computer's `Downloads/IXG-Wall/Screenshots` and can't post them to Slack. Users' browsers never take them. Keep one admin wall open during an event; if none is, each screenshot waits 30 minutes and is dropped, and the event log (Wall stats) says so.
- **Viewer graphs on the timelines** come from the server, which records every feed's count from the moment the feed is on the wall, whether or not anyone has the wall open. Add the day's links before the streams go live to get each stream from its start; the server keeps 24 hours.
- **Smoothest playback on low-spec laptops: decode video in software.** A website can't change how the browser decodes video. On the benchmark laptop (Ryzen 5 4600H with Radeon graphics), software decoding dropped 0% of frames at 30 feeds, against 4–7% on its GPU. To get software decoding, open the wall from a desktop shortcut with this target (one line):

  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%LOCALAPPDATA%\IXG Wall Chrome" --disable-accelerated-video-decode --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --app=https://wall.yourcompany.com
  ```

  - **The separate `--user-data-dir` matters.** It makes the flags apply even when Chrome is already open. That profile signs in once.
  - **The other flags keep feeds smooth.** They stop throttling when other windows cover the wall, and allow autoplay. They're the same flags the laptop's managed wall window uses.
- **Laptop mode still works** for a setup on one machine (`npm run wall`). See README.md.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Browser shows a certificate error, or Caddy logs `challenge failed` | DNS doesn't point at the server yet, or port 80/443 is closed |
| `502 Bad Gateway` | The wall service isn't running: `journalctl -u ixg-wall -n 50` |
| Service won't start: `IXG_PASSWORD is required` / `must be at least 8 characters` | Fix `/etc/ixg-wall/ixg-wall.env` and restart |
| Settings → YouTube API says the key is restricted to other IP addresses | Allow the server's IP in the key's Google Cloud restrictions |
| Feeds show "Missing referrer" (error 153) | Something in front of the wall strips the Referer header; the wall sends `strict-origin-when-cross-origin` |
| Option B: every page is `Forbidden` | The CloudFront `X-Origin-Verify` header is missing or doesn't match `/etc/ixg-wall/origin-token` |
