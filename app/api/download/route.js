import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';
import { Readable } from 'stream';

const execFileAsync = promisify(execFile);
const readyDownloads = new Map();
const ytdlpPath = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const cleanDownload = async (token) => {
  const item = readyDownloads.get(token);
  if (!item) return;
  readyDownloads.delete(token);
  await fs.rm(item.directory, { recursive: true, force: true });
};

const isAllowedUrl = (value) => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) &&
      ['instagram.com', 'instagr.am', 'facebook.com', 'fb.watch', 'fb.com'].some((host) => (
        parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
      ));
  } catch {
    return false;
  }
};

export async function POST(request) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

    const trimmedUrl = url.trim();

    const fbRegex = /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch|fb\.com)\/.+$/i;
    const igRegex = /^(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/.+$/i;

    const isFacebook = fbRegex.test(trimmedUrl);
    const isInstagram = igRegex.test(trimmedUrl);

    if (!isFacebook && !isInstagram) {
      return NextResponse.json(
        { success: false, error: 'Invalid URL. Please provide a valid Facebook or Instagram video URL.' },
        { status: 400 }
      );
    }

    const platform = isFacebook ? 'facebook' : 'instagram';
    let providerError = '';

    if (await fs.access(ytdlpPath).then(() => true).catch(() => false) && isAllowedUrl(trimmedUrl)) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'komyosys-'));
      const outputTemplate = path.join(directory, '%(title).80B [%(id)s].%(ext)s');

      try {
        await execFileAsync(ytdlpPath, [
          '--no-playlist',
          '--no-warnings',
          '--max-filesize', '500M',
          '-f', 'best[height>0][ext=mp4]/best[height>0]/best[ext=mp4]/best',
          '-o', outputTemplate,
          '--', trimmedUrl,
        ], { timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });

        const files = (await fs.readdir(directory)).filter((file) => (
          /\.(mp4|webm|mkv|mov|avi)$/i.test(file)
        ));
        if (!files[0]) throw new Error('No video file was produced. The selected media may be audio-only.');

        const token = crypto.randomUUID();
        readyDownloads.set(token, { directory, file: files[0] });
        setTimeout(() => cleanDownload(token), 10 * 60 * 1000);

        return NextResponse.json({
          success: true,
          videoUrl: `/api/download?token=${token}`,
          title: files[0],
          platform,
        });
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        providerError = String(error.stderr || error.message || '').split('\n').filter(Boolean).pop() || '';
      }
    }

    if (isFacebook) {
      const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
      const facebookPageId = process.env.FACEBOOK_PAGE_ID;

      if (!accessToken || !facebookPageId) {
        return NextResponse.json(
          {
            success: false,
            error: 'Facebook integration is not configured yet. Add FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID to .env.local, then restart the server.',
            resources: [
              { label: 'Open the Meta developer dashboard', url: 'https://developers.facebook.com/apps/' },
              { label: 'Read the Facebook Graph API video documentation', url: 'https://developers.facebook.com/docs/video-api/' },
            ],
            platform,
          },
          { status: 503 }
        );
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
        return NextResponse.json({
          success: true,
          videoUrl: video.source,
          title: video.title || video.description || 'Facebook video',
          platform,
        });
      }
    }

    if (isInstagram) {
      const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
      const instagramUserId = process.env.INSTAGRAM_USER_ID;

      if (!accessToken || !instagramUserId) {
        return NextResponse.json(
          {
            success: false,
            error: 'Instagram integration is not configured yet. Add INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID to .env.local, then restart the server.',
            resources: [
              { label: 'Open the Meta developer dashboard', url: 'https://developers.facebook.com/apps/' },
              { label: 'Read Instagram Graph API setup', url: 'https://developers.facebook.com/docs/instagram-api/getting-started' },
            ],
            platform,
          },
          { status: 503 }
        );
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
        return NextResponse.json({
          success: true,
          videoUrl: media.media_url,
          title: media.caption?.split('\n')[0] || 'Instagram video',
          platform,
        });
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: providerError
          ? `The video could not be downloaded: ${providerError.replace(/^ERROR:\s*/, '').slice(0, 240)}`
          : `${platform.charAt(0).toUpperCase() + platform.slice(1)} videos cannot be downloaded directly through this tool. Official API access requires authentication and user permissions.`,
        resources: [
          { label: 'Use the official Download or Save feature', url: isFacebook ? 'https://www.facebook.com/' : 'https://www.instagram.com/' },
          { label: 'Request your account data export', url: 'https://accountscenter.facebook.com/info_and_permissions/dyi' },
          { label: 'Explore the official Graph APIs', url: 'https://developers.facebook.com/' },
        ],
        platform,
      },
      { status: 400 }
    );
  } catch (error) {
    console.error('Download API error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error. Please try again.' },
      { status: 500 }
    );
  }
}

export async function GET(request) {
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