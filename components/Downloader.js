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

export default function Downloader() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [videoData, setVideoData] = useState(null);
  const [detectedPlatform, setDetectedPlatform] = useState(null);
  const [resources, setResources] = useState([]);
  const [progress, setProgress] = useState(null);
  const pollRef = useRef(null);
  const inputRef = useRef(null);
  const sourceUrlRef = useRef('');

  // A history row can hand its link straight back to the input box.
  useEffect(() => subscribeRefill((link) => {
    setUrl(link);
    updatePlatformInfo(link);
    setStatus('idle');
    resetResults();
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
    setMessage('Video is ready for download!');
    const title = data.title || 'Video';
    setVideoData({
      url: data.videoUrl,
      title,
      platform: data.platform,
      thumbnail: data.thumbnail || '',
      sizeText: data.sizeText || '',
      quality: data.quality || '',
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
      at: new Date().toISOString(),
    });
  };

  // Asks the API for the live job percentage every 700ms until it finishes.
  const pollJob = (jobId) => {
    stopPolling();
    const tick = async () => {
      try {
        const response = await fetch(`/api/download?job=${encodeURIComponent(jobId)}`);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'The progress check failed.');
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
      } catch (error) {
        stopPolling();
        setProgress(null);
        setStatus('error');
        setMessage(error.message || 'An error occurred. Please try again.');
      }
    };
    pollRef.current = setTimeout(tick, 400);
  };

  const validateUrl = (inputUrl) => {
    return Object.values(PLATFORMS).some(p => p.regex.test(inputUrl));
  };

  const detectPlatform = (inputUrl) => {
    for (const [key, platform] of Object.entries(PLATFORMS)) {
      if (platform.regex.test(inputUrl)) {
        return { key, name: platform.name };
      }
    }
    return null;
  };

  const updatePlatformInfo = (inputUrl) => {
    const platform = detectPlatform(inputUrl);
    if (platform) {
      setDetectedPlatform(platform);
    } else {
      setDetectedPlatform(null);
    }
  };

  const handleDownload = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) { setStatus('error'); setMessage('Please enter a video URL.'); return; }
    if (!validateUrl(trimmedUrl)) { setStatus('error'); setMessage('Invalid URL. Please enter a valid video URL from a supported platform.'); return; }
    
    sourceUrlRef.current = trimmedUrl;
    resetResults();
    setStatus('loading');
    setProgress({ percent: 0, stage: 'Sending your link to the server...' });
    try {
      const response = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: trimmedUrl }) });
      const data = await response.json();
      if (!response.ok && !data.error) throw new Error('Failed to process video');
      if (data.jobId) { pollJob(data.jobId); return; }
      if (data.success && data.videoUrl) { showReady(data); }
      else { setStatus('error'); setMessage(data.error || 'This video is not available for direct download.'); setResources(data.resources || []); }
    } catch (error) { setStatus('error'); setMessage(error.message || 'An error occurred. Please try again.'); }
  };

  const handleInputChange = (e) => { 
    setUrl(e.target.value); 
    updatePlatformInfo(e.target.value);
    if (status !== 'loading') { setStatus('idle'); resetResults(); } 
  };
  const handlePaste = async () => {
    try {
      const pastedUrl = await navigator.clipboard.readText();
      setUrl(pastedUrl);
      updatePlatformInfo(pastedUrl);
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
      <p className="panel-description">Paste a public YouTube, Instagram, or Facebook link below. We will check the source before preparing an authorized file.</p>
      <label className="url-label" htmlFor="video-url">Video URL</label>
      <div className="url-input-wrap">
        <input id="video-url" ref={inputRef} className="url-input" type="url" value={url} onChange={handleInputChange} onKeyDown={handleKeyPress} placeholder={detectedPlatform ? EXAMPLE_URLS[detectedPlatform.key] : 'https://www.youtube.com/watch?v=...'} disabled={status === 'loading'} autoComplete="off" />
        <button className="utility-button" type="button" onClick={handlePaste} disabled={status === 'loading'}>Paste</button>
        <button className="clear-button" type="button" onClick={() => { setUrl(''); setDetectedPlatform(null); setStatus('idle'); resetResults(); }} disabled={!url || status === 'loading'}>Clear</button>
      </div>
      {detectedPlatform && <p className="detected-platform">Detected {detectedPlatform.name}</p>}
      <button className="primary-button" type="button" onClick={handleDownload} disabled={status === 'loading' || !url.trim()}>
        {status === 'loading' ? `Preparing media... ${Math.round(progress?.percent || 0)}%` : 'Prepare download'}
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
            <span>{progress?.downloaded && progress?.total ? `${progress.downloaded} of ${progress.total}` : 'Reading the video info...'}</span>
            <span>{progress?.speed ? `${progress.speed} · ${progress.eta ? `ETA ${progress.eta}` : 'almost done'}` : 'Longer videos can take a minute...'}</span>
          </div>
        </div>
      )}
      {status === 'error' && <div className="status-box error" role="alert"><p className="status-heading">Download unavailable</p><p>{message}</p>{resources.length > 0 && <ul className="resource-list">{resources.map((resource) => <li key={resource.url}><a href={resource.url} target="_blank" rel="noopener noreferrer">{resource.label}</a></li>)}</ul>}</div>}
      {status === 'success' && videoData && (
        <div className="result-box">
          <div className="result-row">
            <VideoThumb entry={{ thumbnail: videoData.thumbnail, platform: videoData.platform }} className="result-thumb" />
            <div>
              <p className="result-heading">Your media is ready</p>
              <p className="result-title" title={videoData.title}>{videoData.title}</p>
              <p className="result-meta">{[metaOf(videoData.platform).name, videoData.quality, videoData.sizeText].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          <a className="download-link" href={videoData.url} target="_blank" rel="noopener noreferrer">Save {videoData.platform} file to this device</a>
          <p className="result-note">This copy stays on the server for 10 minutes, then it is removed automatically.</p>
          <p className="result-history-note" role="status">Saved to your download history on this device.</p>
        </div>
      )}
      <p className="panel-footnote">Only use links for content you own or have permission to save. Login walls, DRM, and private content are never bypassed.</p>
    </div>
  );
}