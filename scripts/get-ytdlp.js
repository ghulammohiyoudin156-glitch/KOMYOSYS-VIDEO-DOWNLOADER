const fs = require('fs');
const path = require('path');

const assets = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: {
    x64: 'yt-dlp_linux',
    arm64: 'yt-dlp_linux_aarch64',
  },
};

const platformAssets = assets[process.platform];
const asset = typeof platformAssets === 'string'
  ? platformAssets
  : platformAssets?.[process.arch];
if (!asset) {
  console.log(`Unsupported platform or architecture (${process.platform}/${process.arch}). Install yt-dlp and add it to PATH.`);
  process.exit(0);
}

const dir = path.join(__dirname, '..', 'bin');
const output = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

(async () => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(output, 0o755);
    console.log(`yt-dlp ready: ${output}`);
  } catch (error) {
    console.log(`Could not download yt-dlp (${error.message}). Install it manually and put it on PATH.`);
  }
})();
