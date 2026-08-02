# CampusVault Server (Render)

The CUIMS proxy server for the CampusVault mobile app. This folder is a
self-contained deploy unit — push it to GitHub and connect Render to it.

## Deploy in 4 steps

1. **Create a GitHub repo** (e.g. `campusvault-server`), then push this folder:

   ```bash
   cd render-deploy
   git init
   git add .
   git commit -m "CampusVault CUIMS proxy server"
   git branch -M main
   git remote add origin https://github.com/<you>/campusvault-server.git
   git push -u origin main
   ```

2. **On Render** (render.com, free account, no credit card needed):
   - New → **Web Service** → connect the `campusvault-server` repo
   - It auto-detects Node.js and runs `node src/server.js`
   - Region: pick `Singapore` (closest to the CUIMS servers → faster page loads)

3. **No environment variables needed** — this server runs live CUIMS mode
   only (demo mode has been removed entirely).

4. Deploy → Render gives you a URL like `https://campusvault.onrender.com`.
   **Set that URL in the app**: CampusVault login screen → gear icon (top right)
   → Server URL → paste `https://campusvault.onrender.com` → Save.

## Important notes (live mode)

- The server logs into `students.cuchd.in` **on the cloud**. Universities can
  block datacenter IPs — if login fails from Render, run the server on your
  own machine instead (same Wi-Fi as your phone; the app auto-detects it).
- **Free tier spins down after 15 min of inactivity.** The first request after
  idle takes ~30–60 s to boot (cold start). The app auto-retries and shows
  "Waking up server…" while it boots, so this is mostly transparent.
- Sessions are stored **in memory** — they reset on every deploy/restart. The
  app just re-logs-in, which is expected.
- Anyone who knows your URL could attempt logins through your server. Consider
  keeping the URL private, or add `BASIC_AUTH` later.

## API

`GET /api/health` — status probe (used by the app to wake the server).
All other endpoints are under `/api/*` (login, dashboard, profile, attendance,
timetable, result, fees, receipts, notices + 60+ sections).

## Local dev

```bash
npm install
npm start                # live mode (real CUIMS)
```
