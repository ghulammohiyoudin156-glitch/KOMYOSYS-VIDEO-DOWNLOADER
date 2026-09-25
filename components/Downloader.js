'use client';

import { useState } from 'react';

const PLATFORMS = {
  facebook: { regex: /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch|fb\.com)\/.+$/i, name: 'Facebook' },
  instagram: { regex: /^(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/.+$/i, name: 'Instagram' },
};

export default function Downloader() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [videoData, setVideoData] = useState(null);
  const [detectedPlatform, setDetectedPlatform] = useState(null);
  const [resources, setResources] = useState([]);

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
    
    setStatus('loading');
    setMessage('Processing video URL...');
    setVideoData(null);
    setResources([]);
    try {
      const response = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: trimmedUrl }) });
      const data = await response.json();
      if (!response.ok && !data.error) throw new Error('Failed to process video');
      if (data.success && data.videoUrl) { setStatus('success'); setMessage('Video is ready for download!'); setVideoData({ url: data.videoUrl, title: data.title || 'Video', platform: data.platform }); }
      else { setStatus('error'); setMessage(data.error || 'This video is not available for direct download.'); setResources(data.resources || []); }
    } catch (error) { setStatus('error'); setMessage(error.message || 'An error occurred. Please try again.'); }
  };

  const handleInputChange = (e) => { 
    setUrl(e.target.value); 
    updatePlatformInfo(e.target.value);
    if (status === 'error' || status === 'success') { setStatus('idle'); setMessage(''); setVideoData(null); setResources([]); } 
  };
  const handleKeyPress = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleDownload(); } };

  return (
    <div className="download-panel">
      <p className="panel-kicker">Link workspace</p>
      <h2 className="panel-title">Prepare your media</h2>
      <p className="panel-description">Paste a public link below. We will check the source before preparing an authorized file.</p>
      <label className="url-label" htmlFor="video-url">Video URL</label>
      <div className="url-input-wrap">
        <input id="video-url" className="url-input" type="url" value={url} onChange={handleInputChange} onKeyDown={handleKeyPress} placeholder="https://www.instagram.com/reel/..." disabled={status === 'loading'} autoComplete="off" />
        <button className="clear-button" type="button" onClick={() => { setUrl(''); setDetectedPlatform(null); setStatus('idle'); setMessage(''); setVideoData(null); setResources([]); }} disabled={!url || status === 'loading'}>Clear</button>
      </div>
      {detectedPlatform && <p className="detected-platform">Detected {detectedPlatform.name}</p>}
      <button className="primary-button" type="button" onClick={handleDownload} disabled={status === 'loading' || !url.trim()}>
        {status === 'loading' ? 'Preparing media...' : 'Prepare download'}
      </button>
      {status === 'loading' && <div className="status-box" aria-live="polite">Checking the link and preparing your file...</div>}
      {status === 'error' && <div className="status-box error" role="alert"><p className="status-heading">Download unavailable</p><p>{message}</p>{resources.length > 0 && <ul className="resource-list">{resources.map((resource) => <li key={resource.url}><a href={resource.url} target="_blank" rel="noopener noreferrer">{resource.label}</a></li>)}</ul>}</div>}
      {status === 'success' && videoData && <div className="result-box"><p className="result-heading">Your media is ready</p><p className="result-title" title={videoData.title}>{videoData.title}</p><a className="download-link" href={videoData.url} target="_blank" rel="noopener noreferrer">Download {videoData.platform} video</a></div>}
      <p className="panel-footnote">Only use links for content you own or have permission to save. Login walls, DRM, and private content are never bypassed.</p>
    </div>
  );
}