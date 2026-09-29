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
  const ytdlp = await exists(binaryPath('yt-dlp'));
  const bundledFfmpeg = await exists(binaryPath('ffmpeg'));
  // Mirrors probeFfmpeg(): a system ffmpeg on PATH counts just as much as bin/ffmpeg.
  const systemFfmpeg = bundledFfmpeg
    ? false
    : spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
  const ffmpeg = bundledFfmpeg || systemFfmpeg;

  return NextResponse.json({
    ok: ytdlp,
    platform: process.platform,
    engines: {
      ytdlp,
      ffmpeg,
      ffmpegSource: bundledFfmpeg ? 'bin' : systemFfmpeg ? 'PATH' : 'missing',
    },
    hint: ytdlp
      ? 'Downloads can run here.'
      : 'bin/yt-dlp is missing from this runtime, so downloads cannot start on this host. Vercel cannot run child-process binaries - deploy the Dockerfile to a persistent host instead.',
  });
}
