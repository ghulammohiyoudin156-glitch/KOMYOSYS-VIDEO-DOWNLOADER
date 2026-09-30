import { NextResponse } from 'next/server';
import { execFile, spawn, spawnSync } from 'child_process';
import { createReadStream } from 'fs';
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

const createJob = (platform) => {
  const job = {
    id: crypto.randomUUID(),
    platform,
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
  const kind = job.platform === 'youtube' ? (job.stream > 0 ? 'audio' : 'video') : 'media';
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

// TikTok actively screens the connecting network, so the failure copy says what to do.
const TIKTOK_HINT = ' TikTok also screens the network it is asked from: hosting providers and some regions are refused outright, while a TIKTOK_COOKIES_FILE exported from a signed-in browser, or running this app on a home connection, usually gets through.';
const needsTiktokHint = (message) => /blocked|cookies|login|logged in|unsupported url|region|403/i.test(message);

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

// Turns `My Title [dQw4w9WgXcQ].mp4` into `My Title.mp4` for a readable label in the UI.
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
    const { url } = body || {};

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

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

    const job = createJob(platform);
    void runJob(job, { requestUrl, platform, trimmedUrl }).catch((error) => {
      console.error('Download job failed unexpectedly:', error);
      failJob(job, 'The download could not be completed due to a server error. Please try again.', [], 500);
    });

    return NextResponse.json({ success: true, jobId: job.id, platform });
  } catch (error) {
    console.error('Download API error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error. Please try again.' },
      { status: 500 }
    );
  }
}

// Does the slow work in the background, recording progress on the job so the UI can poll it.
const runJob = async (job, { requestUrl, platform, trimmedUrl }) => {
  let providerError = '';
  let ffmpegMissing = false;

  const ffmpeg = await probeFfmpeg();
  ffmpegMissing = platform === 'youtube' && !ffmpeg.available;

  if (!(await fs.access(ytdlpPath).then(() => true).catch(() => false))) {
    return failJob(job, `The downloader engine (bin/${path.basename(ytdlpPath)}) is missing. Run \`npm install\` (or \`node scripts/get-ytdlp.js\`) once, then restart the server.`, [], 503);
  }
  if (!isAllowedUrl(requestUrl)) {
    return failJob(job, 'That link points to a host this tool is not allowed to reach. Use the official video page link.', [], 503);
  }

  // TikTok can hide posts behind a region or login check. A Netscape cookies.txt
  // exported from a signed-in browser is the supported way past that - nothing is
  // bypassed, the request is simply made as the account that already can see it.
  const cookiesFile = platform === 'tiktok' ? String(process.env.TIKTOK_COOKIES_FILE || '').trim() : '';
  if (cookiesFile && !(await fs.access(cookiesFile).then(() => true).catch(() => false))) {
    return failJob(job, `The TikTok cookies file "${cookiesFile}" could not be read. Point TIKTOK_COOKIES_FILE at a cookies.txt exported from a signed-in browser, or leave it empty.`, [], 503);
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
    '-f', videoFormat(platform, ffmpeg.available),
    ...(cookiesFile ? ['--cookies', cookiesFile] : []),
    ...(ffmpeg.location ? ['--ffmpeg-location', ffmpeg.location] : []),
  ];

  const infoError = await fetchInfo(job, [...baseArgs, '-J', '--no-progress', '--', requestUrl]);
  const run = await runYtdlp(job, [...baseArgs, '-o', outputTemplate, '--', requestUrl]);

  if (run.ok) {
    const files = (await fs.readdir(directory)).filter((file) => (
      /\.(mp4|webm|mkv|mov|avi)$/i.test(file)
    ));
    if (files[0]) {
      const token = crypto.randomUUID();
      const saved = await fs.stat(path.join(directory, files[0])).catch(() => null);
      readyDownloads.set(token, { directory, file: files[0] });
      setTimeout(() => cleanDownload(token), JOB_TTL);
      return finishJob(job, {
        videoUrl: `/api/download?token=${token}`,
        title: displayTitle(files[0]),
        filename: files[0],
        platform,
        thumbnail: job.thumbnail,
        duration: job.duration,
        quality: job.quality,
        sizeText: saved ? formatBytes(saved.size) : '',
        sizeBytes: saved ? saved.size : job.totalBytes,
      });
    }
    providerError = 'No video file was produced. The selected media may be audio-only.';
    await fs.rm(directory, { recursive: true, force: true });
  } else {
    providerError = String(run.message || '').split('\n').filter(Boolean).pop() || infoError;
    await fs.rm(directory, { recursive: true, force: true });
  }

    if (platform === 'facebook') {
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

    if (platform === 'instagram') {
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

  failJob(job, providerError
    ? `The video could not be downloaded: ${providerError.replace(/^ERROR:\s*/, '').slice(0, 240)}${platform === 'youtube' && ffmpegMissing ? FFMPEG_HINT : ''}${platform === 'tiktok' && needsTiktokHint(providerError) ? TIKTOK_HINT : ''}`
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

  readyDownloads.delete(token);
  const filePath = path.join(item.directory, item.file);
  const stream = createReadStream(filePath);
  stream.on('close', () => fs.rm(item.directory, { recursive: true, force: true }));
  const safeFilename = item.file.replace(/[\x00-\x1F\x7F"\\]/g, '_');
  const asciiFilename = safeFilename.replace(/[^\x20-\x7E]/g, '_');
  const contentTypes = {
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  };
  const contentType = contentTypes[path.extname(item.file).toLowerCase()] || 'application/octet-stream';

  return new NextResponse(Readable.toWeb(stream), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
    },
  });
}