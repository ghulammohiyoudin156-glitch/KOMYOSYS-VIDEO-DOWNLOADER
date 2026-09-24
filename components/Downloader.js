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
    <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-6 sm:p-8">
      <div className="text-center mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">KOMYOSYS VIDEO DOWNLOADER</h1>
        <p className="mt-2 text-gray-600 text-sm sm:text-base">Check public Facebook and Instagram links for authorized access.</p>
      </div>
      <div className="space-y-4">
        <div><label htmlFor="video-url" className="block text-sm font-medium text-gray-700 mb-2">Paste a public video URL</label><input id="video-url" type="text" value={url} onChange={handleInputChange} onKeyPress={handleKeyPress} placeholder="Facebook or Instagram URL" className="w-full px-4 py-3 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" disabled={status === 'loading'} autoComplete="off" /></div>
        <button onClick={handleDownload} disabled={status === 'loading' || !url.trim()} className="w-full py-3 px-6 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{status === 'loading' ? (<span className="flex items-center justify-center gap-2"><svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Processing...</span>) : 'Download Video'}</button>
        {status === 'loading' && <p className="text-center text-sm text-blue-600 bg-blue-50 px-4 py-2 rounded-lg">Please wait while we process the video...</p>}
        {status === 'error' && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm"><p className="font-medium">Direct download unavailable</p><p className="mt-1">{message}</p>{resources.length > 0 && <><p className="mt-3 font-medium">Authorized options</p><ul className="mt-1 list-disc space-y-1 pl-5">{resources.map((resource) => <li key={resource.url}><a href={resource.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-red-900">{resource.label}</a></li>)}</ul></>}<p className="mt-3 text-xs text-red-600">Private accounts, login walls, DRM, age gates, geographic restrictions, and copyright protections are not bypassed.</p></div>}
        {status === 'success' && videoData && <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-3 animate-fade-in"><div className="flex items-center justify-between"><span className="text-sm font-medium text-green-800">Ready to download</span><span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full capitalize">{videoData.platform}</span></div><p className="text-sm text-gray-700 truncate" title={videoData.title}>{videoData.title}</p><a href={videoData.url} target="_blank" rel="noopener noreferrer" className="block w-full text-center py-3 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 transition-colors">Download Video</a><p className="text-xs text-green-600 text-center">Opens in new tab. If download doesn&apos;t start, right-click and "Save link as..."</p></div>}
        <div className="mt-6 pt-6 border-t border-gray-100 text-center"><p className="text-xs text-gray-500">Only downloads publicly accessible videos that you are authorized to access. Private accounts, login walls, DRM, and platform restrictions are respected.</p></div>
      </div>
      <style jsx>{`@keyframes fade-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } } .animate-fade-in { animation: fade-in 0.3s ease-out; }`}</style>
    </div>
  );
}