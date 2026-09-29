const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// YouTube now ships most videos as separate video + audio streams, and yt-dlp needs
// ffmpeg to mux them into one file. This fetches a static build next to yt-dlp so the
// app works out of the box. Everything here is best effort: install failures never
// break `npm install`, and the API degrades to single-file formats without ffmpeg.
const builds = {
  win32: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  linux: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz',
};

const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const dir = path.join(__dirname, '..', 'bin');
const output = path.join(dir, binaryName);

const onPath = () => spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

const findBinary = (root) => {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === binaryName) return full;
    }
  }
  return null;
};

(async () => {
  try {
    if (process.env.SKIP_FFMPEG_DOWNLOAD === '1') {
      console.log('Skipping the ffmpeg download (SKIP_FFMPEG_DOWNLOAD=1).');
      return;
    }
    if (fs.existsSync(output)) {
      console.log(`ffmpeg already ready: ${output}`);
      return;
    }
    if (onPath()) {
      console.log('ffmpeg is already available on PATH.');
      return;
    }

    const url = builds[process.platform];
    if (!url) {
      console.log('No automatic ffmpeg build for this OS. Install ffmpeg with your package manager (macOS: brew install ffmpeg).');
      return;
    }

    console.log('Downloading ffmpeg (this one is large, roughly 160 MB)...');
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    fs.mkdirSync(dir, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'komyosys-ffmpeg-'));
    const archive = path.join(workspace, path.basename(url));
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

    const extractDir = path.join(workspace, 'extract');
    fs.mkdirSync(extractDir);
    const extracted = spawnSync('tar', ['-xf', archive, '-C', extractDir], { windowsHide: true });
    if (extracted.status !== 0) {
      throw new Error(`tar could not unpack the archive (${String(extracted.stderr || '').trim() || `exit ${extracted.status}`})`);
    }

    const found = findBinary(extractDir);
    if (!found) throw new Error('ffmpeg was not found inside the archive');

    fs.copyFileSync(found, output);
    if (process.platform !== 'win32') fs.chmodSync(output, 0o755);
    fs.rmSync(workspace, { recursive: true, force: true });
    console.log(`ffmpeg ready: ${output}`);
  } catch (error) {
    console.log(`Could not prepare ffmpeg (${error.message}). Install ffmpeg yourself and restart the server.`);
  }
})();
