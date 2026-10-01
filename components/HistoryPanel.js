'use client';

import { useEffect, useState } from 'react';
import {
  clearHistory,
  formatDuration,
  formatRelative,
  loadHistory,
  metaOf,
  removeHistoryEntry,
  requestRefill,
  subscribeHistory,
} from '../lib/history';
import VideoThumb from './VideoThumb';

export default function HistoryPanel() {
  const [entries, setEntries] = useState([]);
  const [mounted, setMounted] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    setEntries(loadHistory());
    setMounted(true);
    return subscribeHistory(setEntries);
  }, []);

  // Keeps "5 min ago" honest while the page sits open.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const [latest, ...older] = entries;

  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="history-head">
        <div>
          <p className="eyebrow">Saved on this device only</p>
          <h2 id="history-title" className="section-title">Your download history</h2>
        </div>
        {entries.length > 0 && (
          <div className="history-actions">
            <span className="count-chip">{entries.length} {entries.length === 1 ? 'video' : 'videos'}</span>
            <button className="ghost-button" type="button" onClick={() => { if (window.confirm('Clear the whole history from this browser?')) clearHistory(); }}>Clear all</button>
          </div>
        )}
      </div>

      {mounted && entries.length === 0 && (
        <div className="history-empty">
          <span className="empty-mark" aria-hidden="true">▶</span>
          <p className="empty-title">Nothing saved here yet</p>
          <p className="empty-copy">Every finished download lands in this list with the link it came from, so you can always see which video you took last.</p>
        </div>
      )}

      {latest && (
        <article className="history-featured">
          <div className="featured-media">
            <VideoThumb entry={latest} className="featured-thumb" />
            <span className="featured-badge">Last video you downloaded</span>
          </div>
          <div className="featured-body">
            <p className="featured-kicker">Saved {formatRelative(latest.at)}</p>
            <h3 className="featured-title" title={latest.title}>{latest.title}</h3>
            <ul className="chip-row">
              <li className="chip platform" style={{ '--accent': metaOf(latest.platform).accent }}>{metaOf(latest.platform).name}</li>
              {latest.quality ? <li className="chip">{latest.quality}</li> : null}
              {formatDuration(latest.duration) ? <li className="chip">{formatDuration(latest.duration)}</li> : null}
              {latest.sizeText ? <li className="chip">{latest.sizeText}</li> : null}
            </ul>
            <p className="featured-source" title={latest.url}>{latest.url}</p>
            <div className="featured-actions">
              <button className="primary-button compact" type="button" onClick={() => requestRefill(latest.url)}>Prepare this link again</button>
              <a className="chip-button" href={latest.url} target="_blank" rel="noopener noreferrer">Open source page</a>
            </div>
          </div>
        </article>
      )}

      {older.length > 0 && (
        <ul className="history-grid">
          {older.map((entry) => (
            <li key={entry.id || entry.url} className="history-card">
              <VideoThumb entry={entry} className="card-thumb" />
              <div className="card-body">
                <p className="card-title" title={entry.title}>{entry.title}</p>
                <p className="card-meta">{[metaOf(entry.platform).name, entry.kind === 'audio' ? 'audio' : '', entry.sizeText || 'size not reported', formatRelative(entry.at)].filter(Boolean).join(' · ')}</p>
                <div className="card-actions">
                  <button className="link-button" type="button" onClick={() => requestRefill(entry.url)}>Again</button>
                  <a className="link-button" href={entry.url} target="_blank" rel="noopener noreferrer">Open</a>
                  <button className="link-button danger" type="button" onClick={() => removeHistoryEntry(entry.id)}>Remove</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
