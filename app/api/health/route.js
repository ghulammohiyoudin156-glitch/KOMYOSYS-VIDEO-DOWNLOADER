import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

// Read-only status probe. Downloads depend on two native binaries, so this tells you
// at a glance whether a deployment can actually serve them: open /api/health on any
// URL and `"ok": false` means the engine never made it into that runtime (the usual
// case on serverless hosts such as Vercel).
export const dynamic = 'force-dynamic'; // must reflect the running runtime, not build time
const binDir = path.join(process.cwd(), 'bin');
const binaryPath = (name) => path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
const exists = (file) => fs.access(file).then(() => true).catch(() => false);

export async function GET() {
  const backendUrl = String(process.env.DOWNLOADER_BACKEND_URL || '').trim();
  if (process.env.VERCEL && !backendUrl) {
    return NextResponse.json({
      ok: false,
      platform: process.platform,
      engines: { ytdlp: false, ffmpeg: false, ffmpegSource: 'unsupported-runtime' },
      hint: 'Vercel serverless cannot reliably keep download jobs alive. Deploy the Dockerfile to Render and set DOWNLOADER_BACKEND_URL in Vercel.',
    });
  }
  if (backendUrl) {
    try {
      const url = new URL('/api/health', backendUrl);
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      return NextResponse.json(await response.json(), { status: response.status });
    } catch (error) {
      console.error('Downloader backend health check failed:', error);
      return NextResponse.json({
        ok: false,
        platform: process.platform,
        engines: { ytdlp: false, ffmpeg: false, ffmpegSource: 'unavailable' },
        hint: 'The persistent downloader backend could not be reached. Check DOWNLOADER_BACKEND_URL and the Render service status.',
      }, { status: 503 });
    }
  }

  const ytdlp = await exists(binaryPath('yt-dlp'));
  const bundledFfmpeg = await exists(binaryPath('ffmpeg'));
  // Mirrors probeFfmpeg(): a system ffmpeg on PATH counts just as much as bin/ffmpeg.
  const systemFfmpeg = bundledFfmpeg
    ? false
    : spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
  const ffmpeg = bundledFfmpeg || systemFfmpeg;
  // YouTube needs a JavaScript runtime to answer its signature challenge. Reported because
  // a missing one is the difference between a download working and YouTube returning none.
  const jsRuntime = spawnSync(process.execPath, ['--version'], { windowsHide: true }).status === 0
    ? `node ${process.version}`
    : spawnSync('deno', ['--version'], { windowsHide: true }).status === 0
      ? 'deno'
      : null;

  return NextResponse.json({
    ok: ytdlp,
    platform: process.platform,
    engines: {
      ytdlp,
      ffmpeg,
      ffmpegSource: bundledFfmpeg ? 'bin' : systemFfmpeg ? 'PATH' : 'missing',
      jsRuntime,
    },
    hint: ytdlp
      ? jsRuntime
        ? 'Downloads can run here.'
        : 'Downloads can run here, but YouTube will return no formats until a JavaScript runtime (node or deno) is installed.'
      : 'bin/yt-dlp is missing from this runtime, so downloads cannot start on this host. Vercel cannot run child-process binaries - deploy the Dockerfile to a persistent host instead.',
  });
}
