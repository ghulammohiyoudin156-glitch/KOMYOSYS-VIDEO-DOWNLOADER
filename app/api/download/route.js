import { NextResponse } from 'next/server';
import { execFile, spawn, spawnSync } from 'child_process';
import { createReadStream, existsSync } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';
import { Readable } from 'stream';

const execFileAsync = promisify(execFile);
const readyDownloads = new Map();
const binDir = path.join(process.cwd(), 'bin');
const ytdlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ffmpegPath = path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const downloaderBackendOrigin = () => {
  const configured = String(process.env.DOWNLOADER_BACKEND_URL || '').trim();
  if (!configured) return '';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DOWNLOADER_BACKEND_URL must use HTTP or HTTPS.');
  return url.origin;
};

const cleanDownload = async (token) => {
  const item = readyDownloads.get(token);
  if (!item) return;
  readyDownloads.delete(token);
  await fs.rm(item.directory, { recursive: true, force: true });
};

// Job store: the browser polls a running job so it can show a real percentage.
const downloadJobs = new Map();
const JOB_TTL = 10 * 60 * 1000;

const UNIT_BYTES = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
const toBytes = (value, unit) => Number.parseFloat(value) * (UNIT_BYTES[unit] || 0);
const formatBytes = (bytes) => (bytes > 0 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : '');

const DESTINATION_LINE = /^\[download\]\s+Destination:\s+(.+)$/;
const MERGER_LINE = /^\[Merger\]/;
const PERCENT_LINE = /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*(B|KiB|MiB|GiB)/;
const FINISHED_LINE = /^\[download\]\s+100%\s+of\s+~?\s*([\d.]+)\s*(B|KiB|MiB|GiB)\s+in\s+/;
const SPEED_LINE = /\bat\s+([\d.]+)\s*(B|KiB|MiB|GiB)\/s\s+ETA\s+(\S+)/;

const createJob = (platform, mode = 'video') => {
  const job = {
    id: crypto.randomUUID(),
    platform,
    // 'audio' means the visitor asked for the sound track only, so the run never
    // requests a video stream and the result is an .mp3 instead of an .mp4.
    mode: mode === 'audio' ? 'audio' : 'video',
    status: 'queued',
    stage: 'Waiting to start...',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    expectedFiles: 1,
    fileSizes: [],
    currentSize: 0,
    inFilePercent: 0,
    stream: 0,
    speed: '',
    eta: '',
    title: '',
    thumbnail: '',
    duration: 0,
    quality: '',
    result: null,
    error: '',
    resources: [],
    httpStatus: 400,
  };
  downloadJobs.set(job.id, job);
  return job;
};

const expireJob = (id) => {
  setTimeout(() => downloadJobs.delete(id), JOB_TTL);
};

const setStage = (job, status, stage, percent) => {
  job.status = status;
  if (stage) job.stage = stage;
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    // Never move backwards: merges and retries can restart a stream's own counter.
    job.percent = Math.max(job.percent, Math.min(percent, 99.5));
  }
};

const finishJob = (job, result) => {
  job.status = 'ready';
  job.stage = 'Your media is ready';
  job.percent = 100;
  job.result = result;
  expireJob(job.id);
};

const failJob = (job, error, resources = [], httpStatus = 400) => {
  job.status = 'error';
  job.stage = 'Failed';
  job.error = error;
  job.resources = resources;
  job.httpStatus = httpStatus;
  expireJob(job.id);
};

// YouTube usually downloads two streams, so the label says which one is moving
// right now instead of implying the whole download started over.
const streamStage = (job) => {
  // In audio mode the single downloaded file IS the sound track, so calling it "media"
  // would be needlessly vague; the visitor chose audio and is told so throughout.
  const kind = job.mode === 'audio'
    ? 'audio'
    : job.platform === 'youtube' ? (job.stream > 0 ? 'audio' : 'video') : 'media';
  return job.expectedFiles > 1
    ? `Downloading ${kind} (${job.stream + 1} of ${job.expectedFiles})...`
    : `Downloading ${kind}...`;
};

// Turns one yt-dlp stdout line into job progress, e.g.
// `[download]  42.3% of    8.00MiB at  1.20MiB/s ETA 00:06`
const readProgressLine = (job, line) => {
  if (DESTINATION_LINE.test(line)) {
    if (job.currentSize) job.fileSizes.push(job.currentSize);
    job.currentSize = 0;
    job.stream = job.fileSizes.length;
    setStage(job, 'downloading', streamStage(job));
    return;
  }
  if (MERGER_LINE.test(line)) {
    setStage(job, 'processing', 'Combining video and audio...', 99);
    return;
  }
  const finished = line.match(FINISHED_LINE);
  if (finished) {
    job.currentSize = toBytes(finished[1], finished[2]) || job.currentSize;
    job.fileSizes.push(job.currentSize);
    job.currentSize = 0;
    setStage(job, 'downloading', job.fileSizes.length < job.expectedFiles ? 'Stream done, fetching the rest...' : 'Download finished...', 99);
    return;
  }
  const match = line.match(PERCENT_LINE);
  if (!match) return;
  const inFilePercent = Math.min(100, Number.parseFloat(match[1]));
  const size = toBytes(match[2], match[3]);
  if (size > 0) job.currentSize = size;
  job.inFilePercent = inFilePercent;
  job.downloadedBytes = job.fileSizes.reduce((total, value) => total + value, 0) + job.currentSize * (inFilePercent / 100);
  const speed = line.match(SPEED_LINE);
  if (speed) {
    job.speed = `${speed[1]} ${speed[2]}/s`;
    job.eta = speed[3];
  }
  const overall = job.totalBytes > 0
    ? (job.downloadedBytes / job.totalBytes) * 100
    : ((job.fileSizes.length + inFilePercent / 100) / Math.max(1, job.expectedFiles)) * 100;
  setStage(job, 'downloading', streamStage(job), overall);
};

const jobSnapshot = (job) => ({
  jobId: job.id,
  platform: job.platform,
  // Echoed back so the browser can confirm it is showing progress for the mode the
  // visitor actually picked, not a leftover from a previous run.
  mode: job.mode,
  status: job.status,
  stage: job.stage,
  percent: Math.round(job.percent * 10) / 10,
  downloaded: formatBytes(job.downloadedBytes),
  total: job.totalBytes ? formatBytes(job.totalBytes) : '',
  speed: job.speed,
  eta: job.eta,
  title: job.title,
  result: job.result,
  error: job.error,
  resources: job.resources,
});

const PLATFORM_PATTERNS = {
  youtube: /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\/.+$/i,
  facebook: /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch|fb\.com)\/.+$/i,
  instagram: /^(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/.+$/i,
  // Covers @user/video links plus the vm./vt. short links the share button produces.
  tiktok: /^(https?:\/\/)?((www|m|vm|vt)\.)?tiktok\.com\/.+$/i,
};

const ALLOWED_HOSTS = [
  'instagram.com', 'instagr.am',
  'facebook.com', 'fb.watch', 'fb.com',
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'tiktok.com',
];

const isAllowedUrl = (value) => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) &&
      ALLOWED_HOSTS.some((host) => (
        parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
      ));
  } catch {
    return false;
  }
};

// A download is a yt-dlp child process plus a temp file, so the host can only carry a
// handful at a time. Without this ceiling a handful of parallel requests (or one tab
// left open hitting "Prepare download" repeatedly) starts dozens of processes and the
// server runs out of memory, which takes down every other job with it.
const MAX_ACTIVE_JOBS = 3;
const activeJobCount = () => {
  let count = 0;
  for (const job of downloadJobs.values()) {
    if (job.status !== 'ready' && job.status !== 'error') count += 1;
  }
  return count;
};

const detectPlatform = (value) =>
  Object.keys(PLATFORM_PATTERNS).find((platform) => PLATFORM_PATTERNS[platform].test(value)) || null;

const readHeightCap = (value, fallback) => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const maxHeight = () => readHeightCap(process.env.YOUTUBE_MAX_HEIGHT, 1080);
const tiktokMaxHeight = () => readHeightCap(process.env.TIKTOK_MAX_HEIGHT, 1080);

// Modern YouTube usually has no single "progressive" file: video and audio arrive as
// separate streams that have to be muxed together, which needs ffmpeg. The postinstall
// script places a copy in bin/; a system ffmpeg on PATH is honoured too.
let ffmpegProbe = null;
const probeFfmpeg = async () => {
  if (!ffmpegProbe) {
    const local = await fs.access(ffmpegPath).then(() => true).catch(() => false);
    const onPath = local ? false : spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
    ffmpegProbe = { available: local || onPath, location: local ? binDir : null };
  }
  return ffmpegProbe;
};

const FFMPEG_HINT = ' Install ffmpeg (Windows: winget install Gyan.FFmpeg, macOS: brew install ffmpeg) and restart the server to unlock the best quality.';

// yt-dlp shells out to a JS runtime to answer YouTube's signature challenge. The lookup is
// cached because it only depends on what is installed on the host, and probing runs a
// child process that is not worth repeating on every download.
let jsRuntimeCache = null;
const probeRuntime = async () => {
  if (jsRuntimeCache) return jsRuntimeCache;
  const candidates = [
    { name: 'node', executable: process.execPath },
    { name: 'deno', executable: 'deno' },
  ];
  jsRuntimeCache = candidates.find(({ executable }) => (
    spawnSync(executable, ['--version'], { windowsHide: true, timeout: 10000 }).status === 0
  )) || null;
  return jsRuntimeCache;
};

// TikTok actively screens the connecting network, so the failure copy says what to do.
const TIKTOK_HINT = ' TikTok also screens the network it is asked from: hosting providers and some regions are refused outright, while a TIKTOK_COOKIES_FILE exported from a signed-in browser, or running this app on a home connection, usually gets through.';
const needsTiktokHint = (message) => /blocked|cookies|login|logged in|unsupported url|region|403/i.test(message);

// A TikTok "photo post" is a carousel of still images, not a video, and yt-dlp refuses it
// outright ("Unsupported URL"). Only the fully resolved /photo/<id> form can be identified
// with certainty; a short vt.tiktok.com link hides the type until TikTok redirects it, so
// those still fall through to the error handler below.
const PHOTO_POST_PATTERN = /tiktok\.com\/@[^/]+\/photo\//i;
const isPhotoPostUrl = (value) => PHOTO_POST_PATTERN.test(value);

// Reported up front so the user is told what the link actually is, instead of watching a job
// run and then getting a raw "Unsupported URL" back from yt-dlp.
const PHOTO_POST_MESSAGE = 'This is a TikTok photo post (a slideshow of images), not a video, so there is no video file to download. Open the post in TikTok and use "Save photo" to keep the individual images, or send a link to a post that has a video in it.';

// Instagram and Facebook refuse anonymous requests outright ("Instagram API is not granting
// access", "Cannot parse data"), because those pages are only rendered for a logged-in
// account. yt-dlp can read the cookies straight out of a browser profile that is already
// signed in, so when the plain attempt is refused each locally installed browser is tried in
// turn. Nothing is bypassed - the request is simply made as the account the person already
// is. Each probe just has to reach Instagram's login page; the cookie jar is copied
// internally so a profile that Chrome has locked still works.
const BROWSER_COOKIE_TARGETS = ['chrome', 'edge', 'firefox', 'brave', 'opera'];
// Only browsers that are actually installed are probed. yt-dlp spends several seconds
// deciding that a missing profile does not exist, and with five candidates on the list a
// machine that has neither Firefox nor Brave pays that cost on every failed download.
const BROWSER_PROFILE_DIRS = {
  chrome: '%LOCALAPPDATA%/Google/Chrome/User Data',
  edge: '%LOCALAPPDATA%/Microsoft/Edge/User Data',
  firefox: '%APPDATA%/Mozilla/Firefox/Profiles',
  brave: '%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data',
  opera: '%APPDATA%/Opera Software/Opera Stable',
};

const browserInstalled = (target) => {
  const relative = BROWSER_PROFILE_DIRS[target];
  return Boolean(relative) && existsSync(path.join(...relative.split('/').map((part) => (
    part.startsWith('%') ? process.env[part.slice(1, -1)] || '' : part
  ))));
};

// Filled in by browserHasSession: why each profile could not be used. `locked` means the
// browser is open, `undecryptable` means the cookie store exists but Windows refused to
// decrypt it. Reporting the reason turns an unexplained failure into a real next step.
const LOCKED_BROWSERS = new Set();
const UNDECRYPTABLE_BROWSERS = new Set();

const browserHasSession = (target) => {
  const probe = [
    '--cookies-from-browser', target,
    '--simulate', '--skip-download', '--no-warnings', '--playlist-items', '0',
    '--', 'https://www.instagram.com/',
  ];
  const result = spawnSync(ytdlpPath, probe, { windowsHide: true, timeout: BROWSER_PROBE_TIMEOUT, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // Chrome and Edge hold an exclusive lock on their cookie database while running, so the
  // profile cannot be read. That is worth saying out loud - closing the browser is all it
  // takes, and without that hint the message looks like an app fault.
  if (/could not copy|EncryptedCookie|database is locked/i.test(output)) {
    LOCKED_BROWSERS.add(target);
    return false;
  }
  // The cookie store is readable as a file but Windows refuses to decrypt the values, which
  // happens when the server process does not run as the Windows user who owns that profile.
  // Closing the browser does not help here, so it is kept separate from the locked case.
  if (/Failed to decrypt with DPAPI|dpapi/i.test(output)) {
    UNDECRYPTABLE_BROWSERS.add(target);
    return false;
  }
  if (/no cookies|not found|failed to open|Unsupported/i.test(output)) return false;
  // Reached the page and the extractor got as far as asking for the real API response, which
  // only happens once cookies were supplied.
  return !/ERROR:/i.test(output) || /login|required|challenge/i.test(output);
};

const BROWSER_LOCKED = /could not copy.*cookie database|encryptedcookie|database is locked/i;

// Reported so the answer to "why did Instagram/Facebook fail" is on screen rather than left
// for the user to guess from a raw extractor error.
const LOGIN_HINT = ' Instagram and Facebook only hand over the real media link to a signed-in account. Two steps fix this: (1) close Chrome, Edge or Firefox completely, including the icon in the system tray, then (2) press Download again. The app then makes the request using the session you are already signed in to. Some hosting providers and regions are refused no matter who is signed in.';

// Chrome, Edge and Firefox keep an exclusive lock on their cookie database while they are
// running, so the signed-in session cannot be read. Quitting the browser is the whole fix,
// and saying so is more use than any extractor message.
const BROWSER_LOCKED_HINT = ' A signed-in browser session was found but could not be read because the browser is still open. Close Chrome, Edge or Firefox completely (check the tray), then press Download again - the app will use the session you are already signed in to.';

// Windows encrypts browser cookies with a key tied to the Windows user account, so a server
// running as a different user (a service, or an elevated prompt) can see the cookie file but
// not decrypt it. Closing the browser does not help, so this says what does: export the
// session to a cookies.txt by hand and point the app at that file.
const BROWSER_UNDECRYPTABLE_HINT = ' Instagram and Facebook only serve these posts to a signed-in account, and Chrome 127+ will not let any other program read its cookies (App-Bound encryption), so reading the browser directly cannot work. The fix is a one-time export: sign in to Instagram/Facebook in Chrome, install a "Get cookies.txt LOCALLY" extension, export your cookies, and save the file as cookies.txt in the Downloads folder. This app picks it up automatically - no setting to change.';

// Each browser probe has to wait for a full page load, and every browser installed on the
// machine is probed before giving up. A slow probe therefore stalls the job for minutes, so
// the budget is kept short: if a profile cannot be read this quickly it is not going to be
// readable at all, and the browser-locked hint is the more useful answer anyway.
const BROWSER_PROBE_TIMEOUT = 12000;

const videoFormat = (platform, ffmpegAvailable) => {
  if (platform === 'tiktok') {
    const cap = tiktokMaxHeight();
    // TikTok posts are vertical and normally come as one ready-made MP4 (the clean
    // variant, without the watermark), so the capped progressive file is taken first.
    // `best` on its own means "video and audio in one file", so the merge pairs are
    // kept as the tail: a post that only has split streams still gets sound.
    return [
      `best[height<=${cap}][ext=mp4]`,
      'best[ext=mp4]',
      `best[height<=${cap}]`,
      'best',
      `bv*[height<=${cap}]+ba[ext=m4a]`,
      'bv*+ba',
      'b',
    ].join('/');
  }
  if (platform !== 'youtube') return 'best[height>0][ext=mp4]/best[height>0]/best[ext=mp4]/best';
  const cap = maxHeight();
  // Without ffmpeg only a single ready-made file can be used, so never request a merge.
  if (!ffmpegAvailable) return `b[height<=${cap}][ext=mp4]/b[height<=${cap}]`;
  // H.264 + AAC first (plays everywhere), then any mp4 pair, then any stream pair.
  return [
    `bv*[height<=${cap}][ext=mp4][vcodec^=avc]+ba[ext=m4a]`,
    `b[height<=${cap}][ext=mp4][vcodec^=avc]`,
    `bv*[height<=${cap}][ext=mp4]+ba[ext=m4a]`,
    `b[height<=${cap}][ext=mp4]`,
    `bv*[height<=${cap}]+ba`,
    `b[height<=${cap}]`,
  ].join('/');
};

// "Only audio" mode. The best available audio-only stream is taken and, when ffmpeg is
// present, re-encoded to MP3 at a high quality bitrate so the file opens everywhere.
// Without ffmpeg the best single audio file is returned untouched (usually .m4a/.opus),
// because a conversion cannot be done - an untouched file is better than a failed job.
const audioFormat = (ffmpegAvailable) => {
  if (!ffmpegAvailable) return 'ba[ext=m4a]/ba[ext=webm]/b[ext=m4a]/ba/b';
  return 'bestaudio/b';
};

// The extra yt-dlp switches that turn a downloaded audio stream into an .mp3. Only safe
// to pass when ffmpeg exists, hence the guard at the call site.
const audioConversionArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];

// Turns `My Title [dQw4w9WgXcQ].mp4` into `My Title.mp4` for a readable label in the UI.
// The `[id]` block is only stripped when it really sits directly before the extension;
// a title that legitimately contains brackets keeps them instead of being mangled.
const displayTitle = (filename) => filename.replace(/\s*\[[^\]]*\](?=\.[^.]+$)/, '');

// Runs yt-dlp as a child process so stdout can be watched for progress lines.
const runYtdlp = (job, args) => new Promise((resolve) => {
  const child = spawn(ytdlpPath, args, { windowsHide: true });
  const stderrLines = [];
  const kill = setTimeout(() => child.kill('SIGKILL'), JOB_TTL);
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    const lines = (buffer + String(chunk)).split('\r\n').join('\n').split('\n');
    buffer = lines.pop();
    lines.forEach((line) => {
      if (line.trim()) readProgressLine(job, line.trim());
    });
  });
  child.stderr.on('data', (chunk) => {
    String(chunk).split('\n').forEach((line) => {
      if (line.trim()) stderrLines.push(line.trim());
    });
    if (stderrLines.length > 60) stderrLines.splice(0, stderrLines.length - 60);
  });
  child.on('error', (error) => {
    clearTimeout(kill);
    resolve({ ok: false, message: String(error.message || error) });
  });
  child.on('close', (code) => {
    clearTimeout(kill);
    resolve({ ok: code === 0, message: stderrLines.join('\n') });
  });
});

// YouTube answers a throttled or briefly broken transfer with a 403/timeout partway
// through a stream. Those are worth another go, because yt-dlp keeps the partial
// `.part` file in `directory` and picks the transfer back up instead of starting over.
const isTransient = (message) => /HTTP Error (403|429|5\d\d)|Forbidden|Too Many Requests|read timeout|Connection reset|Remote end closed/i.test(String(message || ''));

const runWithRetry = async (job, args, directory, attempts = 3) => {
  let result = await runYtdlp(job, args);
  for (let attempt = 1; attempt < attempts && !result.ok && isTransient(result.message); attempt += 1) {
    const partial = await fs.readdir(directory).catch(() => []);
    if (!partial.some((file) => file.endsWith('.part'))) break; // nothing to resume
    setStage(job, 'downloading', 'Connection throttled by the source - resuming...', job.percent);
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    // The signed media URLs expire, so they have to be fetched again before resuming.
    result = await runYtdlp(job, args);
  }
  return result;
};

// One metadata request up front: gives the title and the byte sizes that make the
// overall percentage accurate across the video + audio streams.
const fetchInfo = async (job, args) => {
  setStage(job, 'fetching-info', 'Checking the video page...', 1);
  try {
    const { stdout } = await execFileAsync(ytdlpPath, args, {
      timeout: 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    const info = JSON.parse(stdout);
    const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads : [];
    // A merged choice such as "133+140" is one entry that downloads two separate files.
    job.expectedFiles = Math.max(1, requested.reduce(
      (count, item) => count + String(item.format_id || '').split('+').filter(Boolean).length,
      0
    ));
    // filesize_approx is the combined size of everything that entry will fetch.
    const sizes = requested.map((item) => item.filesize || item.filesize_approx || 0);
    job.totalBytes = sizes.length && sizes.every((size) => size > 0)
      ? sizes.reduce((total, size) => total + size, 0)
      : 0;
    job.title = typeof info.title === 'string' ? info.title.slice(0, 120) : '';
    job.thumbnail = typeof info.thumbnail === 'string' ? info.thumbnail : '';
    job.duration = Number(info.duration) || 0;
    const chosenHeight = Number(requested[0]?.height) || 0;
    job.quality = chosenHeight ? `${chosenHeight}p` : '';
    return '';
  } catch (error) {
    return String(error.stderr || error.message || '').split('\n').filter(Boolean).pop() || '';
  }
};

export async function POST(request) {
  const backendConfigured = String(process.env.DOWNLOADER_BACKEND_URL || '').trim();
  if (process.env.VERCEL && !backendConfigured) {
    return NextResponse.json(
      { success: false, error: 'Vercel cannot reliably run download jobs directly. Deploy the Dockerfile to Render and set DOWNLOADER_BACKEND_URL in Vercel.' },
      { status: 503 }
    );
  }
  if (backendConfigured) {
    try {
      const backendOrigin = downloaderBackendOrigin();
      const upstream = await fetch(`${backendOrigin}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': request.headers.get('content-type') || 'application/json' },
        body: await request.text(),
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      return NextResponse.json(await upstream.json(), { status: upstream.status });
    } catch (error) {
      console.error('Downloader backend request failed:', error);
      return NextResponse.json(
        { success: false, error: 'The persistent downloader service is unavailable. Check DOWNLOADER_BACKEND_URL and the Render service status.' },
        { status: 503 }
      );
    }
  }

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Request body must be valid JSON.' },
        { status: 400 }
      );
    }
    // 'audio' asks for the sound track only. Anything else - including an older client
    // that sends no mode at all - keeps the original video behaviour, so the change is
    // backwards compatible with the frontend that is already deployed.
    const { url, mode } = body || {};

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

    const wantedMode = mode === 'audio' ? 'audio' : 'video';

    const trimmedUrl = url.trim();
    // Accept links pasted without a protocol (youtube.com/watch?v=...).
    const requestUrl = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
    const platform = detectPlatform(trimmedUrl);

    if (!platform) {
      return NextResponse.json(
        { success: false, error: 'Invalid URL. Please provide a valid YouTube, TikTok, Facebook, or Instagram video URL.' },
        { status: 400 }
      );
    }

    // Rejected before a job is created, so the user is told the link is a photo slideshow
    // straight away rather than after a progress bar that was never going to produce a file.
    if (platform === 'tiktok' && isPhotoPostUrl(requestUrl)) {
      return NextResponse.json(
        {
          success: false,
          error: PHOTO_POST_MESSAGE,
          resources: [
            { label: 'Open TikTok to save the images', url: 'https://www.tiktok.com/' },
          ],
        },
        { status: 400 }
      );
    }

    if (activeJobCount() >= MAX_ACTIVE_JOBS) {
      return NextResponse.json(
        { success: false, error: 'The server is already preparing other videos. Please wait for one to finish, then try again.' },
        { status: 429 }
      );
    }

    const job = createJob(platform, wantedMode);
    void runJob(job, { requestUrl, platform, trimmedUrl, mode: wantedMode }).catch((error) => {
      console.error('Download job failed unexpectedly:', error);
      failJob(job, 'The download could not be completed due to a server error. Please try again.', [], 500);
    });

    return NextResponse.json({ success: true, jobId: job.id, platform, mode: wantedMode });
  } catch (error) {
    console.error('Download API error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error. Please try again.' },
      { status: 500 }
    );
  }
}

// Does the slow work in the background, recording progress on the job so the UI can poll it.
const runJob = async (job, { requestUrl, platform, trimmedUrl, mode = 'video' }) => {
  // Single switch that decides what this run produces. Read once at the top so every
  // branch below (format, args, file matching, error copy) stays consistent.
  const audioOnly = mode === 'audio';
  let providerError = '';
  // Extra context collected during the run and only worth showing if the download failed, so
  // a successful download is never annotated with a warning the user has to act on.
  let providerNote = '';
  let ffmpegMissing = false;
  // Set when a browser holding a signed-in session was open, which is the one case where
  // the fix is on the user's side: quitting the browser frees the cookie store. The same is
  // true when Windows refused to decrypt that store - neither can be fixed from here, but
  // the two need different words so the message matches the real cause.
  let browserWasLocked = false;
  let browserWasUndecryptable = false;

  const ffmpeg = await probeFfmpeg();
  ffmpegMissing = platform === 'youtube' && !ffmpeg.available;

  if (!(await fs.access(ytdlpPath).then(() => true).catch(() => false))) {
    return failJob(job, `The downloader engine (bin/${path.basename(ytdlpPath)}) is missing. Run \`npm install\` (or \`node scripts/get-ytdlp.js\`) once, then restart the server.`, [], 503);
  }
  if (!isAllowedUrl(requestUrl)) {
    return failJob(job, 'That link points to a host this tool is not allowed to reach. Use the official video page link.', [], 503);
  }

  // Instagram, Facebook and TikTok answer a request made from a signed-in account and
  // refuse anonymous ones. Instagram in particular returns an empty media response for a
  // reel whose owner has a private or restricted account. A cookies.txt exported from a
  // signed-in browser is the supported way past that: nothing is bypassed, the request is
  // simply made as the account that can already see the post. A single COOKIES_FILE covers
  // every platform and the per-platform variable wins when both are set.
  const COOKIE_ENV_BY_PLATFORM = {
    youtube: ['YOUTUBE_COOKIES_FILE', 'COOKIES_FILE'],
    tiktok: ['TIKTOK_COOKIES_FILE', 'COOKIES_FILE'],
    instagram: ['INSTAGRAM_COOKIES_FILE', 'COOKIES_FILE'],
    facebook: ['FACEBOOK_COOKIES_FILE', 'COOKIES_FILE'],
  };

  let cookieFile = COOKIE_ENV_BY_PLATFORM[platform]
    .map((name) => String(process.env[name] || '').trim())
    .find(Boolean) || '';

  // Falling back to a cookies.txt that is simply lying around saves the user from having to
  // set an environment variable and restart the server just to get Instagram or Facebook
  // working. The Downloads folder and the project folder are where an exported file
  // realistically lands, so those are checked before giving up.
  // A cookies.txt that was exported for one platform can sit in a folder of its own, so the
  // conventional locations inside the project are checked too. This runs even when an
  // environment variable is set, because the variable points at a file that may not exist yet.
  const autoCookieFiles = [
    path.join(process.cwd(), 'cookies.txt'),
    path.join(process.cwd(), 'cookies', 'instagram-facebook.txt'),
    path.join(process.cwd(), 'cookies', 'cookies.txt'),
    path.join(os.homedir(), 'Downloads', 'cookies.txt'),
    path.join(os.homedir(), 'Desktop', 'cookies.txt'),
  ];
  const cookiePlatform = platform.charAt(0).toUpperCase() + platform.slice(1);
  const readable = (candidate) => fs.access(candidate).then(() => true).catch(() => false);
  let cookieFileMissing = false;
  if (cookieFile && !(await readable(cookieFile))) {
    // The setting points at a file that is not there. That is a setup mistake, not a reason to
    // refuse the download: a public post is still readable without a session, so the path is
    // dropped and yt-dlp is asked anyway. If the post really is login-walled, the failure
    // message below already explains how to supply a cookies.txt.
    cookieFileMissing = true;
    cookieFile = '';
  }
  if (!cookieFile) {
    for (const candidate of autoCookieFiles) {
      if (await readable(candidate)) {
        cookieFile = candidate;
        break;
      }
    }
  }

  // A configured-but-absent cookies file is worth mentioning only when the download then
  // fails, so the note rides along with the error instead of standing in front of it.
  if (cookieFileMissing) {
    providerNote = ` The ${cookiePlatform} cookies file was not found, so the download was attempted without a signed-in session. Public posts still work; a login-walled post needs a cookies.txt exported from a signed-in browser.`;
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'komyosys-'));
  const outputTemplate = path.join(directory, '%(title).80B [%(id)s].%(ext)s');
  const baseArgs = [
    '--no-playlist',
    '--no-warnings',
    '--retries', '3',
    '--fragment-retries', '3',
    '--socket-timeout', '30',
    '--max-filesize', '500M',
    '--newline',
    '-f', audioOnly ? audioFormat(ffmpeg.available) : videoFormat(platform, ffmpeg.available),
    // Converting to MP3 is an ffmpeg job. Asking for it without ffmpeg would turn a
    // perfectly good audio download into an error, so it is only added when possible.
    ...(audioOnly && ffmpeg.available ? audioConversionArgs : []),
    ...(cookieFile ? ['--cookies', cookieFile] : []),
    ...(ffmpeg.location ? ['--ffmpeg-location', ffmpeg.location] : []),
  ];

  // YouTube now signs its streams with a JavaScript challenge. Without a JS runtime to
  // solve it, yt-dlp can only return the handful of formats that do not need one, and
  // frequently no formats at all. Node is already a dependency of this app, so it is
  // offered as the solver and deno is accepted too when an operator installs it.
  const jsArgs = [];
  const runtime = await probeRuntime();
  if (runtime) jsArgs.push('--js-runtimes', `${runtime.name}:${runtime.executable}`);

  // YouTube picks a player client per request and periodically refuses the one yt-dlp
  // defaults to ("Sign in to confirm you're not a bot"), so a refusal is retried with the
  // next client instead of failing the job outright. These are the clients that still
  // answer without cookies as of this release; ios/web_safari/tv are deliberately left
  // out because YouTube rejects them outright.
  const youtubeClients = ['default', 'android', 'mweb', 'web_embedded'];

  // YouTube's CDN throttles long transfers from one IP and answers a burst of range
  // requests with `HTTP Error 403: Forbidden` partway through a stream. Asking for a
  // single fragment at a time keeps the request rate low enough to get past it, and
  // the longer linear backoff gives a throttled client time to be let back in.
  const throttleArgs = [
    '--concurrent-fragments', '1',
    '--retries', '10',
    '--fragment-retries', '10',
    '--retry-sleep', 'linear=1::5',
  ];

  // A refusal that a different YouTube player client can still answer is retried with that
// client; anything else is a real failure and is reported as-is.
const CLIENT_REFUSAL = /sign in to confirm|confirm you'?re not a bot|429|too many requests|requested format is not available/i;

  const attemptArgs = (client, extra = []) => [
    ...baseArgs,
    ...jsArgs,
    ...(client ? ['--extractor-args', `youtube:player_client=${client}`] : []),
    ...extra,
  ];

  // Metadata is fetched first so the UI can show the title, thumbnail and duration straight
  // away. It is only used for display, so a failure here does not stop the download.
  const infoError = await fetchInfo(job, [...attemptArgs(null), '-J', '--no-progress', '--', requestUrl]);
  let run = await runWithRetry(
    job,
    [...attemptArgs(null), ...throttleArgs, '-o', outputTemplate, '--', requestUrl],
    directory,
  );

  if (!run.ok && platform === 'youtube' && CLIENT_REFUSAL.test(run.message || '')) {
    for (const client of youtubeClients) {
      const retry = await runWithRetry(
        job,
        [...attemptArgs(client), ...throttleArgs, '-o', outputTemplate, '--', requestUrl],
        directory,
      );
      if (retry.ok) {
        run = retry;
        break;
      }
      providerError = retry.message || providerError;
    }
  }

  // Instagram and Facebook answer an anonymous request with a login/refusal error rather
  // than a link. Both keep the page behind a signed-in session, so the same attempt is
  // repeated using the cookies of a browser on this machine that is already signed in. The
  // cookie file from the environment, when set, already took part in the first attempt.
  const needsLogin = (message) => (
    /not granting access|empty media response|login required|sign in|cannot parse data|unsupported url|private|restricted/i
      .test(String(message || ''))
  );
  if (!run.ok && !cookieFile && ['instagram', 'facebook'].includes(platform) && needsLogin(run.message)) {
    let browserLocked = false;
    let browserUndecryptable = false;
    for (const target of BROWSER_COOKIE_TARGETS) {
      // Skipping browsers that are not installed keeps the failure fast: probing a missing
      // profile still costs yt-dlp a few seconds, and the user is staring at a spinner.
      if (!browserInstalled(target)) continue;
      if (!browserHasSession(target)) {
        // A browser that is open holds its cookie store, so remember that the fix is simply
        // to close it and say so rather than reporting a bare extractor error.
        if (LOCKED_BROWSERS.has(target)) browserLocked = true;
        if (UNDECRYPTABLE_BROWSERS.has(target)) browserUndecryptable = true;
        continue;
      }
      setStage(job, 'fetching-info', `Signing in with ${target}...`, job.percent);
      const retry = await runWithRetry(
        job,
        [...attemptArgs(null, ['--cookies-from-browser', target]), ...throttleArgs, '-o', outputTemplate, '--', requestUrl],
        directory,
      );
      if (retry.ok) {
        run = retry;
        break;
      }
      providerError = retry.message || providerError;
    }
    if (browserLocked) browserWasLocked = true;
    if (browserUndecryptable) browserWasUndecryptable = true;
  }

  if (run.ok) {
    // An audio-only run produces .mp3 (or the untouched .m4a/.opus/.webm when ffmpeg is
    // missing), so the video-only extension list would report "no file was produced" for a
    // download that actually succeeded. Both lists are therefore matched on mode.
    const VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|mov|avi)$/i;
    const AUDIO_EXTENSIONS = /\.(mp3|m4a|opus|aac|flac|wav|ogg|weba)$/i;
    const files = (await fs.readdir(directory)).filter((file) => (
      (audioOnly ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS).test(file)
    ));
    // A photo post has no audio track at all, so in audio mode that is a real, explainable
    // outcome rather than a mysterious "no file" failure.
    const noAudioAtAll = audioOnly && !files.length && (await fs.readdir(directory)).some((file) => VIDEO_EXTENSIONS.test(file));
    if (noAudioAtAll) {
      providerError = 'This post has no sound track, so there is no audio file to download. Switch back to video to save it instead.';
    } else if (files[0]) {
      const token = crypto.randomUUID();
      const saved = await fs.stat(path.join(directory, files[0])).catch(() => null);
      readyDownloads.set(token, { directory, file: files[0] });
      setTimeout(() => cleanDownload(token), JOB_TTL);
      return finishJob(job, {
        videoUrl: `/api/download?token=${token}`,
        title: displayTitle(files[0]),
        filename: files[0],
        platform,
        // Lets the UI label the result honestly: an audio save shows audio wording and an
        // audio icon, a video save keeps the existing video presentation.
        kind: audioOnly ? 'audio' : 'video',
        mode,
        extension: path.extname(files[0]).replace('.', '').toLowerCase(),
        thumbnail: job.thumbnail,
        duration: job.duration,
        // A height means nothing for an audio file, so the mode is named instead. The
        // frontend falls back to showing the extension when this is blank.
        quality: audioOnly ? '' : job.quality,
        sizeText: saved ? formatBytes(saved.size) : '',
        sizeBytes: saved ? saved.size : job.totalBytes,
      });
    }
    // Only reached when the run succeeded but produced nothing matching the expected
    // extension. The wording follows the mode so an audio attempt is never told about a
    // missing "video" file, and an already-recorded reason (a silent photo post) is kept.
    if (!providerError) {
      providerError = audioOnly
        ? 'No audio file was produced for this link. The post may be silent, or the source may have withdrawn the sound track.'
        : 'No video file was produced. The selected media may be audio-only.';
    }
    await fs.rm(directory, { recursive: true, force: true });
  } else {
    providerError = String(run.message || '').split('\n').filter(Boolean).pop() || infoError;
    await fs.rm(directory, { recursive: true, force: true });
  }

    // The Graph API fallback is only worth trying when the direct attempt gave no usable
    // reason to report. When yt-dlp already explained itself (a login wall, for instance)
    // that explanation reaches the user further down together with the login hint, which
    // says far more than "a fallback is not configured".
    if (platform === 'facebook' && !providerError) {
      const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
      const facebookPageId = process.env.FACEBOOK_PAGE_ID;

      if (!accessToken || !facebookPageId) {
        return failJob(job, 'The direct Facebook download failed, and the optional Graph API fallback is not configured. Add FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID to the host environment.', [
          { label: 'Open the Meta developer dashboard', url: 'https://developers.facebook.com/apps/' },
          { label: 'Read the Facebook Graph API video documentation', url: 'https://developers.facebook.com/docs/video-api/' },
        ], 503);
      }

      const graphUrl = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v23.0'}/${facebookPageId}/videos`);
      graphUrl.searchParams.set('fields', 'id,source,permalink_url,description,title');
      graphUrl.searchParams.set('limit', '100');
      graphUrl.searchParams.set('access_token', accessToken);

      const graphResponse = await fetch(graphUrl);
      const graphData = await graphResponse.json();
      const normalizedUrl = trimmedUrl.replace(/\/$/, '').toLowerCase();
      const video = graphData.data?.find((item) => (
        item.source && item.permalink_url?.replace(/\/$/, '').toLowerCase() === normalizedUrl
      ));

      if (graphResponse.ok && video?.source) {
        return finishJob(job, {
          videoUrl: video.source,
          title: video.title || video.description || 'Facebook video',
          platform,
        });
      }
    }

    if (platform === 'instagram' && !providerError) {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      const instagramUserId = process.env.INSTAGRAM_USER_ID;

      if (!accessToken || !instagramUserId) {
        return failJob(job, 'The direct Instagram download failed, and the optional Graph API fallback is not configured. Add INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID to the host environment.', [
          { label: 'Open the Meta developer dashboard', url: 'https://developers.facebook.com/apps/' },
          { label: 'Read Instagram Graph API setup', url: 'https://developers.facebook.com/docs/instagram-api/getting-started' },
        ], 503);
      }

      const graphUrl = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v23.0'}/${instagramUserId}/media`);
      graphUrl.searchParams.set('fields', 'id,media_type,media_url,permalink,caption');
      graphUrl.searchParams.set('limit', '100');
      graphUrl.searchParams.set('access_token', accessToken);

      const graphResponse = await fetch(graphUrl);
      const graphData = await graphResponse.json();
      const normalizedUrl = trimmedUrl.replace(/\/$/, '').toLowerCase();
      const media = graphData.data?.find((item) => (
        item.media_type === 'VIDEO' &&
        item.permalink?.replace(/\/$/, '').toLowerCase() === normalizedUrl
      ));

      if (graphResponse.ok && media?.media_url) {
        return finishJob(job, {
          videoUrl: media.media_url,
          title: media.caption?.split('\n')[0] || 'Instagram video',
          platform,
        });
      }
    }

  const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);
  const resources = platform === 'youtube'
    ? [
      { label: 'Save it the official way with YouTube Offline', url: 'https://support.google.com/youtube/answer/6147765' },
      { label: 'Open your own videos in YouTube Studio', url: 'https://studio.youtube.com/' },
      { label: 'Read the YouTube Terms of Service', url: 'https://www.youtube.com/static?template=terms' },
    ]
    : platform === 'tiktok'
      ? [
        { label: 'Use the Save video button inside TikTok', url: 'https://www.tiktok.com/' },
        { label: 'Request a copy of your own TikTok data', url: 'https://www.tiktok.com/settings/offline-data' },
        { label: 'Read the TikTok Terms of Service', url: 'https://www.tiktok.com/legal/page/row/terms-of-service/en' },
      ]
      : [
      { label: 'Use the official Download or Save feature', url: platform === 'facebook' ? 'https://www.facebook.com/' : 'https://www.instagram.com/' },
      { label: 'Request your account data export', url: 'https://accountscenter.facebook.com/info_and_permissions/dyi' },
      { label: 'Explore the official Graph APIs', url: 'https://developers.facebook.com/' },
    ];

  // A short share link only reveals that it points at a photo post once TikTok has redirected
  // it and yt-dlp has refused it, so the same explanation is repeated here rather than letting
  // the raw "Unsupported URL" reach the user.
  // When YouTube has flagged the host's IP it refuses every player client, and the only real
// fix is to make the request as a signed-in account. Saying so beats echoing the raw
// "Sign in to confirm you're not a bot" that yt-dlp returns.
const YOUTUBE_BOT_HINT = ' YouTube has rate limited this network and is now asking every request to prove it is not a bot. Waiting a while helps, and for repeated use a YOUTUBE_COOKIES_FILE pointing at a cookies.txt exported from a signed-in browser gets through.';

  const unsupported = /unsupported url/i.test(providerError || '');
  const photoPost = platform === 'tiktok' && (isPhotoPostUrl(requestUrl) || unsupported);
  const botChecked = platform === 'youtube' && CLIENT_REFUSAL.test(providerError || '');
  const loginNeeded = ['instagram', 'facebook'].includes(platform) && needsLogin(providerError || '');

  // When the extractor refused because the post needs a signed-in account, the raw
  // yt-dlp sentence ("Instagram sent an empty media response... use --cookies") is noise to
  // a visitor of this page: it names command line flags they have no way to run. The
  // guidance below already says what to do, so only the diagnosis is kept, not the jargon.
  const cleanReason = (message) => {
    const text = String(message || '').replace(/^ERROR:\s*/, '').split('\n').pop().trim();
    const jargon = /empty media response|not granting access|cannot parse data|login required|cookies-from-browser|--cookies\b|Unsupported URL/i;
    if (!loginNeeded && !jargon.test(text)) return text.slice(0, 240);
    if (/cannot parse data/i.test(text)) {
      return 'Facebook did not return the video data for this link.';
    }
    return 'This post is only visible to a signed-in account.';
  };

  // "Close the browser" and "Windows cannot decrypt the cookies" can both be true of the same
// machine. Only the second one is the real blocker, so it is shown alone - telling the user
// to close a browser that will not help is worse than saying nothing.
const sessionHint = browserWasUndecryptable
    ? BROWSER_UNDECRYPTABLE_HINT
    : browserWasLocked
      ? BROWSER_LOCKED_HINT
      : '';

  // The login hint ends with "close your browser", which is useless once the cookie store has
  // proven unreadable. In that case the account is irrelevant and the message is replaced
  // rather than appended, so the two never contradict each other.
  // When the cookies file itself is missing there is no session to reuse, so neither the
  // "sign in" wording nor the "close the browser" tip can help. providerNote already says
  // what is actually wrong and what to do about it, and stacking the other two on top only
  // buries it.
  const loginHint = providerNote || browserWasUndecryptable || browserWasLocked ? '' : LOGIN_HINT;
  const showSessionHint = !providerNote && !browserWasUndecryptable;

  failJob(job, photoPost
    ? PHOTO_POST_MESSAGE
    : providerError
      ? `The video could not be downloaded: ${cleanReason(providerError)}${providerNote}${botChecked ? YOUTUBE_BOT_HINT : ''}${loginNeeded ? loginHint : ''}${showSessionHint ? sessionHint : ''}${platform === 'youtube' && ffmpegMissing ? FFMPEG_HINT : ''}${platform === 'tiktok' && needsTiktokHint(providerError) ? TIKTOK_HINT : ''}`
    : platform === 'youtube'
      ? `YouTube did not return a downloadable file for this link. The video may be private, age-restricted, region locked, or a live stream.${ffmpegMissing ? FFMPEG_HINT : ''}`
      : platform === 'tiktok'
        ? 'TikTok did not return a video for this link. The account may be private, the post may be a photo slideshow rather than a video, or TikTok may be refusing this network. A TIKTOK_COOKIES_FILE can help with region checks.'
        : `${platformLabel} videos cannot be downloaded directly through this tool. Official API access requires authentication and user permissions.`, resources, 400);
};

export async function GET(request) {
  // `?job=<id>` reports live progress; `?token=<id>` streams the finished file.
  const jobId = request.nextUrl.searchParams.get('job');
  if (String(process.env.DOWNLOADER_BACKEND_URL || '').trim()) {
    try {
      const backendOrigin = downloaderBackendOrigin();
      const token = request.nextUrl.searchParams.get('token');
      if (token) {
        const target = new URL('/api/download', backendOrigin);
        target.searchParams.set('token', token);
        return NextResponse.redirect(target, 307);
      }
      if (!jobId) {
        return NextResponse.json({ success: false, error: 'A download job is required.' }, { status: 400 });
      }
      const target = new URL('/api/download', backendOrigin);
      target.searchParams.set('job', jobId);
      const upstream = await fetch(target, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await upstream.json();
      if (data.result?.videoUrl?.startsWith('/')) {
        data.result.videoUrl = `${backendOrigin}${data.result.videoUrl}`;
      }
      return NextResponse.json(data, { status: upstream.status });
    } catch (error) {
      console.error('Downloader backend poll failed:', error);
      return NextResponse.json(
        { success: false, error: 'The persistent downloader service is unavailable. Check DOWNLOADER_BACKEND_URL and the Render service status.' },
        { status: 503 }
      );
    }
  }

  if (jobId) {
    const job = downloadJobs.get(jobId);
    if (!job) {
      return NextResponse.json(
        { success: false, error: 'This download no longer exists. Please submit the link again.' },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, ...jobSnapshot(job) });
  }

  const token = request.nextUrl.searchParams.get('token');
  const item = token ? readyDownloads.get(token) : null;

  if (!item) {
    return new NextResponse('This download has expired. Please submit the link again.', { status: 404 });
  }

  const filePath = path.join(item.directory, item.file);
  const saved = await fs.stat(filePath).catch(() => null);
  if (!saved) {
    // The temp directory was reaped already, so nothing can be served from it.
    readyDownloads.delete(token);
    await fs.rm(item.directory, { recursive: true, force: true });
    return new NextResponse('This download has expired. Please submit the link again.', { status: 404 });
  }

  const stream = createReadStream(filePath);
  // The token is NOT spent when the read finishes. `createReadStream` emits 'end' as
  // soon as the file has been pulled into memory, which for anything but a very large
  // file happens in milliseconds - long before the bytes reach the browser. Deleting
  // the token there meant that one dropped tunnel/Wi-Fi/mobile connection destroyed
  // the file and the user could never finish saving it. Instead the entry stays in
  // readyDownloads and the 10 minute TTL set when the job finished reclaims it, so a
  // reload or a retried click gets the whole file again.
  const safeFilename = item.file.replace(/[\x00-\x1F\x7F"\\]/g, '_');
  const asciiFilename = safeFilename.replace(/[^\x20-\x7E]/g, '_');
  const contentTypes = {
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    // Audio-only saves. `.m4a`/`.opus`/`.aac` appear when ffmpeg is unavailable and the
    // best ready-made audio stream is returned untouched instead of being converted.
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.opus': 'audio/opus',
    '.ogg': 'audio/ogg',
    '.weba': 'audio/webm',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
  };
  const contentType = contentTypes[path.extname(item.file).toLowerCase()] || 'application/octet-stream';

  return new NextResponse(Readable.toWeb(stream), {
    headers: {
      'Content-Type': contentType,
      // Without a length the browser cannot show a real progress bar for the save, and
      // some proxies hold the response open instead of streaming it through.
      'Content-Length': String(saved.size),
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
    },
  });
}