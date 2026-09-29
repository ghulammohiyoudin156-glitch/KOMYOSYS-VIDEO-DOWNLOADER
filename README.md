# KOMYOSYS Video Downloader

Paste a public video link and the app prepares an MP4 you can save.
Supported sources: **YouTube**, **TikTok**, **Instagram**, **Facebook**.

## Run it

```bash
npm install     # downloads yt-dlp + ffmpeg into bin/
npm run dev     # http://localhost:3000
```

`npm install` runs `scripts/get-ytdlp.js` and `scripts/get-ffmpeg.js`, which
place `bin/yt-dlp.exe` and `bin/ffmpeg.exe` (`yt-dlp` / `ffmpeg` on
Linux/macOS) for the server to call. If those downloads are blocked, run either
script again, or install the tools yourself and put them on PATH. The app needs
no API key or login for YouTube links.

## How a download works

1. `components/Downloader.js` detects the platform from the pasted link
   (YouTube, TikTok, Instagram, or Facebook) and posts it to `/api/download`.
2. `app/api/download/route.js` validates the host, starts a background job and
   answers with a `jobId` straight away, so long downloads never hit a request
   timeout. The job runs yt-dlp into a temporary folder (max 500 MB, 10 minute
   cap, playlists disabled) and records live progress - percentage, megabytes,
   speed and ETA - parsed from yt-dlp's own output lines.
3. The page polls `GET /api/download?job=<id>` every 700 ms while the job runs
   and paints a progress bar; the same endpoint returns the final result or the
   error once the job settles.
4. The file is held behind a single-use token and streamed back with a
   `Content-Disposition` header, then deleted (also auto-purged after 10 minutes).

Jobs live in memory only, so restarting the server forgets unfinished jobs -
the page reports a clear error instead of hanging.

## Download history

Finished downloads are remembered in the browser, not on the server:

* `lib/history.js` keeps up to 24 rows in `localStorage` under
  `komyosys.history.v1` - source link, title, platform, thumbnail, duration,
  quality, size and timestamp. Re-downloading the same link updates its row
  instead of stacking a duplicate.
* `components/HistoryPanel.js` renders the newest row as a featured card ("last
  video you downloaded") and the rest as a grid. **Prepare this link again**
  drops the link back into the input, **Open** goes to the source page, and each
  row can be removed individually (or all at once).
* Other open tabs are kept in sync through the `storage` event, and the relative
  timestamps ("5 min ago") refresh once a minute.

Because the list is per browser, it survives reloads and server restarts but is
cleared with the browser's site data, and it never exposes links to other
devices.

## Look and feel

`app/globals.css` holds the whole theme as CSS variables: an ink-dark base with a
slow drifting aurora, glass panels, and a mint/sky/coral accent gradient shared by
the brand mark, primary buttons, progress bar and download link. Motion (aurora,
progress shimmer, hover lifts) is switched off under
`prefers-reduced-motion`, and keyboard focus is always visible.

## YouTube notes

* **ffmpeg is required for most YouTube videos**, because YouTube normally
  delivers video and audio as separate streams that must be muxed into one
  file. `npm install` fetches it automatically; set `SKIP_FFMPEG_DOWNLOAD=1` to
  skip that ~160 MB download when ffmpeg is already on PATH.
* Quality is capped at 1080p by default — change it with `YOUTUBE_MAX_HEIGHT`
  in `.env.local`. H.264 video + AAC audio is preferred so the result is a
  `.mp4` that plays on phones, TVs, and editors, falling back to newer codecs
  only when no AVC stream is offered.
* If ffmpeg is missing, the app falls back to a single ready-made stream and,
  when even that is unavailable, returns a message telling you to install ffmpeg
  instead of failing silently.
* Private, age-restricted, region-locked, and live-stream links can fail; the
  app reports the reason instead of bypassing any protection.
* Copy `.env.local.example` to `.env.local` to configure the optional
  Facebook/Instagram Graph API fallbacks.

## TikTok notes

* Public posts need no configuration or key - the same `bin/yt-dlp` binary has a
  TikTok extractor, and it takes the clean MP4 rather than the watermarked copy.
* Both shapes of link work: the long `tiktok.com/@user/video/123…` page link and
  the `vm.tiktok.com/xxxx` / `vt.tiktok.com/xxxx` short links the share button
  produces. Height is capped by `TIKTOK_MAX_HEIGHT` (1080 by default).
* TikTok screens the network that comes asking, so posts are commonly refused
  from cloud and hosting IPs and from some regions. The app reports that plainly
  and points at the two ways through - a normal home connection, or
  `TIKTOK_COOKIES_FILE` for posts your own signed-in account can already see.
  Nothing is bypassed: private accounts, DRM and region locks stay as they are.
* Photo slidehows have no video track and are reported as such.

## Hosting it online

A download is a `yt-dlp` process writing a file to disk, so the host has to allow
child processes and a real filesystem. Check any URL with `GET /api/health`:
`"ok": true` means it can serve downloads, `"ok": false` means the engine is not
there and every link will fail with "the downloader engine is missing".

**Vercel can host the site but not the downloads.** Its build succeeds (the
bootstrap scripts swallow errors and exit 0), yet a serverless function cannot
spawn `bin/yt-dlp`, so `/api/health` reports `ok: false` there for every platform,
YouTube included. Keep Vercel for the UI or move the whole app:

```bash
docker build -t komyosys-downloader .
docker run --rm -p 3000:3000 komyosys-downloader   # then open /api/health
```

That image is the deploy target for any persistent container host, and two hosts
are pre-wired in this repo so there is nothing to configure:

- **Render** - New > Blueprint on this repo. `render.yaml` selects the Dockerfile,
  pins one instance, uses `/api/health` as the health check, and prompts for the
  optional cookies/Meta secrets instead of storing them in Git.
- **Fly.io** - `fly launch` then `fly deploy`. `fly.toml` builds the same
  Dockerfile, pins the port to 3000 on both sides of the proxy, and checks
  `/api/health`.
- **Railway, a VPS, anywhere else** - build the image, or run
  `npm ci && npm run build && npm start` on a machine that has `ffmpeg` available.

Each of them builds the image as-is, reads the injected `PORT`, and runs
`next start` on `0.0.0.0`. The Dockerfile installs ffmpeg from apt (the code
honours a system ffmpeg on `PATH`) and lets `npm install` fetch the matching Linux
`yt-dlp` into `bin/`, so nothing Windows-specific from this machine is baked in.

Free tiers that suspend an idle instance are fine for trying this out, but they
add a cold start to the first link after a quiet period, and the smallest tiers
have little disk - a 1080p file plus its audio track can briefly need a few
hundred MB while ffmpeg muxes them.

Set the same variables as `.env.local` in the host's dashboard. For
`TIKTOK_COOKIES_FILE`, mount the file rather than committing it, e.g.
`docker run -v ./cookies:/app/cookies:ro -e TIKTOK_COOKIES_FILE=/app/cookies/tiktok.txt …`.
Jobs live in memory and files land on local disk, so use one instance - a
load-balanced autoscale would lose jobs between requests.

Heads-up on where you download *from*: TikTok usually refuses datacenter IP ranges,
so a cloud-hosted app often reports the "TikTok may be refusing this network"
message where the same link succeeds on your home connection.

## Responsible use

Only save videos you own or have permission to save. This tool does not bypass
logins, DRM, or platform restrictions, and downloading other people's content
can breach the platform's terms of service and copyright law.
