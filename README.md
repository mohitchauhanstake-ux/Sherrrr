# Sherrr

Send files directly from one device's browser to another. Files travel
device-to-device over WebRTC; the only server involved is a tiny signaling
service that helps the two browsers find each other.

## Layout

| Folder | What it is |
|---|---|
| `web/` | The web app (Vite + React + TypeScript). Deploys as static files. |
| `signaling/` | The signaling service (Cloudflare Worker + Durable Object). |

## Run locally

```sh
npm install
npm run dev:signal   # signaling on http://localhost:8787
npm run dev:web      # app on http://localhost:5180
```

Open the app in two browser windows: click **Send files** in one, and open the
link or enter the code in the other.

To try it from a phone on the same Wi-Fi, open `http://<your-computer-ip>:5180`.
Over plain `http` the phone's browser will not offer save-to-folder (browsers
only allow that on `https`), so it uses download mode.

## Test

With both dev servers running:

```sh
npx -w web playwright install chromium   # first time only
npm run test:e2e
```

This pairs two headless browser pages, transfers files, cuts the connection
mid-transfer, and checks the received files against the originals by SHA-256.
It also covers save-to-folder mode and skipping files that already arrived.

## Deploy

1. Signaling: `cd signaling && npx wrangler deploy` (needs a free Cloudflare
   account). Note the `workers.dev` URL it prints.
2. Web: set `VITE_SIGNALING_URL=wss://<that-url>` in the build environment,
   run `npm run build`, and publish `web/dist` (Netlify, Cloudflare Pages, or
   any static host).

## How a transfer works

- The sender creates a room and shares its 6-character code (or QR/link).
- Both browsers connect to the room; the service passes their WebRTC
  connection details to each other, then is no longer involved.
- The sender announces the file list. On accept, the receiver says which files
  it already has, and the sender streams the rest in small chunks.
- The receiver acknowledges bytes only after writing them, and the sender never
  runs more than 32 MB ahead, so memory use stays flat for any transfer size.
- If the connection drops, both sides reconnect by themselves and continue
  from the last byte written.

## Known limits

- No relay (TURN) server yet, so pairs of networks that block direct
  connections cannot connect.
- No end-to-end checksum yet; the connection itself is encrypted and
  integrity-protected by WebRTC.
- Save-to-folder needs a Chromium browser on `https` or `localhost`. Other
  browsers hold files in browser storage until each one is saved.
- After a page reload, finished files are skipped but a file that was partway
  through starts again from zero.
- The room creator sends and the joiner receives; to send the other way, start
  a new room from the other device.
