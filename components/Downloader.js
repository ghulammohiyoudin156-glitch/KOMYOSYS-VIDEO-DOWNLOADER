'use client';

import { useEffect, useRef, useState } from 'react';
import { addHistoryEntry, metaOf, subscribeRefill } from '../lib/history';
import VideoThumb from './VideoThumb';

const PLATFORMS = {
  youtube: { regex: /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\/.+$/i, name: 'YouTube' },
  facebook: { regex: /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch|fb\.com)\/.+$/i, name: 'Facebook' },
  instagram: { regex: /^(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/.+$/i, name: 'Instagram' },
  tiktok: { regex: /^(https?:\/\/)?((www|m|vm|vt)\.)?tiktok\.com\/.+$/i, name: 'TikTok' },
};

const EXAMPLE_URLS = {
  youtube: 'https://www.youtube.com/watch?v=...',
  facebook: 'https://www.facebook.com/watch/?v=...',
  instagram: 'https://www.instagram.com/reel/...',
  tiktok: 'https://www.tiktok.com/@username/video/...',
};

// What the visitor wants out of the link. `video` is the default so the panel behaves
// exactly as before for anyone who never touches the switch.
const MODES = {
  video: { key: 'video', label: 'Video', hint: 'Full video file (MP4)', word: 'video' },
  audio: { key: 'audio', label: 'Only audio', hint: 'Sound track only (MP3)', word: 'audio' },
};

const detectPlatform = (inputUrl) => {
  for (const [key, platform] of Object.entries(PLATFORMS)) {
    if (platform.regex.test(inputUrl)) return { key, name: platform.name };
  }
  return null;
};

export default function Downloader() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [videoData, setVideoData] = useState(null);
  const [detectedPlatform, setDetectedPlatform] = useState(null);
  const [resources, setResources] = useState([]);
  const [progress, setProgress] = useState(null);
  const [mode, setMode] = useState('video');
  // Frozen for the lifetime of one run. A React state value can change mid-download,
  // and the result card must describe the file that was actually produced, not whatever
  // the switch happens to say afterwards.
  const runModeRef = useRef('video');
  const pollRef = useRef(null);
  const inputRef = useRef(null);
  const sourceUrlRef = useRef('');

  // A history row can hand its link straight back to the input box.
  useEffect(() => subscribeRefill((link) => {
    setUrl(link);
    setDetectedPlatform(detectPlatform(link));
    setStatus('idle');
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
    setProgress(null);
    setVideoData(null);
    setResources([]);
    setMessage('');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => inputRef.current?.focus(), 260);
  }), []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  const resetResults = () => {
    stopPolling();
    setProgress(null);
    setVideoData(null);
    setResources([]);
    setMessage('');
  };

  const showReady = (data) => {
    stopPolling();
    setProgress(null);
    setStatus('success');
    // The server is the authority on what was produced: it knows whether ffmpeg turned
    // the audio into an .mp3 or whether a ready-made audio file was passed through. If an
    // older build sends no `kind`, the mode frozen at submit time is the safe fallback.
    const savedKind = data.kind === 'audio' ? 'audio' : data.kind === 'video' ? 'video' : (runModeRef.current === 'audio' ? 'audio' : 'video');
    const isAudio = savedKind === 'audio';
    const extension = (data.extension || (isAudio ? 'mp3' : 'mp4')).toLowerCase();
    setMessage(isAudio ? 'Your audio is ready to download!' : 'Video is ready for download!');
    const title = data.title || (isAudio ? 'Audio' : 'Video');
    setVideoData({
      url: data.videoUrl,
      title,
      platform: data.platform,
      kind: savedKind,
      extension,
      // A resolution means nothing for a sound track, so the format is named instead. The
      // result meta line is built from this and must never say "1080p" for an mp3.
      quality: data.quality || (isAudio ? extension.toUpperCase() : ''),
      thumbnail: isAudio ? '' : data.thumbnail || '',
      sizeText: data.sizeText || '',
    });
    if (!sourceUrlRef.current) return;
    addHistoryEntry({
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}`,
      url: sourceUrlRef.current,
      title,
      platform: data.platform || 'other',
      filename: data.filename || '',
      thumbnail: data.thumbnail || '',
      duration: Number(data.duration) || 0,
      quality: data.quality || '',
      sizeText: data.sizeText || '',
      sizeBytes: Number(data.sizeBytes) || 0,
      kind: savedKind,
      at: new Date().toISOString(),
    });
  };

  // Asks the API for the live job percentage every 700ms until it finishes.
  // A progress check is a tiny request, so on a tunnel, phone network or a cold host
  // it can fail for reasons that have nothing to do with the download (a 408, a 502
  // from the proxy, one dropped Wi-Fi packet). Treating the first hiccup as a failed
  // download threw away a job that was still running fine on the server, so a real
  // server verdict is separated from a transient network error and only the former
  // ends the wait.
  const TRANSIENT_POLL_FAILURES = 5;
  const pollJob = (jobId) => {
    stopPolling();
    let misses = 0;
    const tick = async () => {
      let response;
      let data;
      try {
        response = await fetch(`/api/download?job=${encodeURIComponent(jobId)}`);
        data = await response.json();
      } catch {
        misses += 1;
        if (misses < TRANSIENT_POLL_FAILURES) {
          setProgress((previous) => ({ ...previous, stage: 'Reconnecting to the server...' }));
          pollRef.current = setTimeout(tick, 1500);
          return;
        }
        stopPolling();
        setProgress(null);
        setStatus('error');
        setMessage('Lost the connection to the server while the download was running. The link may still finish on the host - please try again.');
        return;
      }

      if (!response.ok || !data.success) {
        // "This download no longer exists" is a real answer from the server, not a
        // dropped request, so there is nothing to retry there.
        stopPolling();
        setProgress(null);
        setStatus('error');
        setMessage(data.error || 'The progress check failed.');
        setResources(data.resources || []);
        return;
      }

      misses = 0;
      if (data.status === 'ready' && data.result) { showReady(data.result); return; }
      if (data.status === 'error') {
        stopPolling();
        setProgress(null);
        setStatus('error');
        setMessage(data.error || 'This video is not available for direct download.');
        setResources(data.resources || []);
        return;
      }
      setProgress((previous) => ({
        // The info request has no percentage to report yet, so creep a little
        // (capped) to show the user the job is alive.
        percent: data.status === 'fetching-info'
          ? Math.min(9, (previous?.percent || 0) + 1)
          : Number(data.percent) || 0,
        stage: data.stage,
        downloaded: data.downloaded,
        total: data.total,
        speed: data.speed,
        eta: data.eta,
      }));
      pollRef.current = setTimeout(tick, 700);
    };
    pollRef.current = setTimeout(tick, 400);
  };

  const handleDownload = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) { setStatus('error'); setMessage('Please enter a video URL.'); return; }
    if (!detectPlatform(trimmedUrl)) { setStatus('error'); setMessage('Invalid URL. Please enter a valid video URL from a supported platform.'); return; }
    
    sourceUrlRef.current = trimmedUrl;
    // Frozen before the request goes out: if the visitor flips the switch while the job
    // runs, the finished result card still describes the file that was really produced.
    runModeRef.current = mode;
    resetResults();
    setStatus('loading');
    setProgress({ percent: 0, stage: 'Sending your link to the server...' });
    try {
      const response = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: trimmedUrl, mode }) });
      const data = await response.json();
      if (!response.ok && !data.error) throw new Error('Failed to process video');
      if (data.jobId) { pollJob(data.jobId); return; }
      if (data.success && data.videoUrl) { showReady(data); }
      else { setStatus('error'); setMessage(data.error || 'This video is not available for direct download.'); setResources(data.resources || []); }
    } catch (error) { setStatus('error'); setMessage(error.message || 'An error occurred. Please try again.'); }
  };

  const handleInputChange = (e) => { 
    setUrl(e.target.value); 
    setDetectedPlatform(detectPlatform(e.target.value));
    if (status !== 'loading') { setStatus('idle'); resetResults(); } 
  };
  const handlePaste = async () => {
    try {
      const pastedUrl = await navigator.clipboard.readText();
      setUrl(pastedUrl);
      setDetectedPlatform(detectPlatform(pastedUrl));
      setStatus('idle');
      resetResults();
    } catch {
      setStatus('error');
      setMessage('Clipboard access was unavailable. Paste the link directly into the field.');
    }
  };
  const handleKeyPress = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleDownload(); } };

  return (
    <div className="download-panel">
      <p className="panel-kicker">Link workspace</p>
      <h2 className="panel-title">Prepare your media</h2>
      <p className="panel-description">Paste a public YouTube, TikTok, Instagram, or Facebook link below. We will check the source before preparing an authorized file.</p>
      <label className="url-label" htmlFor="video-url">Video URL</label>
      <div className="url-input-wrap">
        <input id="video-url" ref={inputRef} className="url-input" type="url" value={url} onChange={handleInputChange} onKeyDown={handleKeyPress} placeholder={detectedPlatform ? EXAMPLE_URLS[detectedPlatform.key] : 'https://www.youtube.com/watch?v=...'} disabled={status === 'loading'} autoComplete="off" />
        <button className="utility-button" type="button" onClick={handlePaste} disabled={status === 'loading'}>Paste</button>
        <button className="clear-button" type="button" onClick={() => { setUrl(''); setDetectedPlatform(null); setStatus('idle'); resetResults(); }} disabled={!url || status === 'loading'}>Clear</button>
      </div>
      {detectedPlatform && <p className="detected-platform">Detected {detectedPlatform.name}</p>}
      <div className="mode-row" role="radiogroup" aria-label="What to download">
        {Object.values(MODES).map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={mode === option.key}
            className={`mode-option${mode === option.key ? ' active' : ''}`}
            onClick={() => setMode(option.key)}
            // Switching while a job runs would make the progress bar describe a different
            // file than the one being fetched, so the switch waits for the run to finish.
            disabled={status === 'loading'}
          >
            <span className="mode-label">{option.label}</span>
            <span className="mode-hint">{option.hint}</span>
          </button>
        ))}
      </div>
      <button className="primary-button" type="button" onClick={handleDownload} disabled={status === 'loading' || !url.trim()}>
        {status === 'loading' ? `Preparing ${MODES[mode].word}... ${Math.round(progress?.percent || 0)}%` : `Prepare ${MODES[mode].word} download`}
      </button>
      {status === 'loading' && (
        <div className="status-box" aria-live="polite">
          <div className="progress-head">
            <span className="progress-stage">{progress?.stage || 'Checking the link and preparing your file...'}</span>
            <strong className="progress-percent">{Math.round(progress?.percent || 0)}%</strong>
          </div>
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress?.percent || 0)}>
            <div className="progress-fill" style={{ width: `${Math.max(progress?.percent || 0, 2)}%` }} />
          </div>
          <div className="progress-meta">
            <span>{progress?.downloaded && progress?.total ? `${progress.downloaded} of ${progress.total}` : `Reading the ${MODES[mode].word} info...`}</span>
            <span>{progress?.speed ? `${progress.speed} · ${progress.eta ? `ETA ${progress.eta}` : 'almost done'}` : 'Longer videos can take a minute...'}</span>
          </div>
        </div>
      )}
      {status === 'error' && <div className="status-box error" role="alert"><p className="status-heading">Download unavailable</p><p>{message}</p>{resources.length > 0 && <ul className="resource-list">{resources.map((resource) => <li key={resource.url}><a href={resource.url} target="_blank" rel="noopener noreferrer">{resource.label}</a></li>)}</ul>}</div>}
      {status === 'success' && videoData && (
        <div className="result-box">
          <div className="result-row">
            {/* An audio file has no picture, so the thumbnail is replaced by a format badge
                instead of leaving an empty square in the card. */}
            {videoData.kind === 'audio'
              ? <span className="result-audio-badge" aria-hidden="true">{videoData.extension.toUpperCase()}</span>
              : <VideoThumb entry={{ thumbnail: videoData.thumbnail, platform: videoData.platform }} className="result-thumb" />}
            <div>
              <p className="result-heading">{videoData.kind === 'audio' ? 'Your audio is ready' : 'Your media is ready'}</p>
              <p className="result-title" title={videoData.title}>{videoData.title}</p>
              <p className="result-meta">{[metaOf(videoData.platform).name, videoData.quality, videoData.sizeText].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          {/* Playing the track in the browser is a natural extra for an audio save, and it
              also proves the file really is playable before the visitor saves it. */}
          {videoData.kind === 'audio' && <audio className="result-audio-player" src={videoData.url} controls preload="none">Your browser cannot play this audio file. Use the save link below instead.</audio>}
          <a className="download-link" href={videoData.url} target="_blank" rel="noopener noreferrer">
            {videoData.kind === 'audio' ? `Save audio to this device` : `Save ${videoData.platform} file to this device`}
          </a>
          <p className="result-note">This copy stays on the server for 10 minutes, then it is removed automatically.</p>
          <p className="result-history-note" role="status">Saved to your download history on this device.</p>
        </div>
      )}
      <p className="panel-footnote">Only use links for content you own or have permission to save. Login walls, DRM, and private content are never bypassed.</p>
    </div>
  );
}