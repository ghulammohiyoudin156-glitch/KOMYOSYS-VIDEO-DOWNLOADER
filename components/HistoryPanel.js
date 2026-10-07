'use client';

import { useEffect, useState } from 'react';
import {
  clearHistory,
  formatDuration,
  formatRelative,
  loadHistory,
  metaOf,
  removeHistoryEntry,
  requestInputFocus,
  requestRefill,
  subscribeHistory,
} from '../lib/history';
import VideoThumb from './VideoThumb';

export default function HistoryPanel() {
  const [entries, setEntries] = useState([]);
  const [mounted, setMounted] = useState(false);
  // Clearing is destructive, so the button asks once inline instead of throwing a
  // browser dialog at the visitor - and it resets itself if the list empties anyway.
  const [confirmingClear, setConfirmingClear] = useState(false);
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

  // Never carry a pending "clear?" question into the next session's list.
  useEffect(() => {
    if (entries.length === 0) setConfirmingClear(false);
  }, [entries.length]);

  const [latest, ...older] = entries;

  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="history-head">
        <div>
          <p className="eyebrow">On this device</p>
          <h2 id="history-title" className="section-title">Download history</h2>
        </div>
        {entries.length > 0 && (
          <div className="history-actions">
            <span className="count-chip">{entries.length} {entries.length === 1 ? 'item' : 'items'}</span>
            {confirmingClear ? (
              <span className="confirm-row" role="status">
                <button className="ghost-button confirm-yes" type="button" onClick={() => { clearHistory(); setConfirmingClear(false); }}>Yes, clear all</button>
                <button className="ghost-button confirm-no" type="button" onClick={() => setConfirmingClear(false)}>Cancel</button>
              </span>
            ) : (
              <button className="ghost-button" type="button" onClick={() => setConfirmingClear(true)}>Clear all</button>
            )}
          </div>
        )}
      </div>

      {mounted && entries.length === 0 && (
        <div className="history-empty">
          <span className="empty-emblem" aria-hidden="true">
            <span className="empty-emblem-core">▶</span>
          </span>
          <p className="empty-title">No downloads yet</p>
          <p className="empty-copy">Your prepared files will appear here, ready to save again. Paste a link above to get started.</p>
          <button className="primary-button compact empty-cta" type="button" onClick={() => requestInputFocus(null)}>Paste a link</button>
          {/* Ghost cards hint at the shape of a filled list without faking real entries. */}
          <ul className="empty-preview" aria-hidden="true">
            {[0, 1, 2].map((slot) => (
              <li className="preview-card" key={slot} style={{ animationDelay: `${slot * 0.35}s` }}>
                <span className="preview-thumb" />
                <span className="preview-lines">
                  <span className="preview-line" style={{ width: `${74 - slot * 9}%` }} />
                  <span className="preview-line short" style={{ width: `${48 - slot * 7}%` }} />
                </span>
              </li>
            ))}
          </ul>
          <ul className="empty-points" aria-label="What you can do here">
            <li>Video and audio</li>
            <li>Stored on this device</li>
            <li>No account needed</li>
          </ul>
        </div>
      )}

      {latest && (
        <article className="history-featured">
          <div className="featured-media">
            <VideoThumb entry={latest} className="featured-thumb" />
            <span className="featured-badge">Latest download</span>
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
            <div className="featured-actions">
              <button className="primary-button compact" type="button" onClick={() => requestRefill(latest.url)}>Prepare this link again</button>
              <a className="chip-button" href={latest.url} target="_blank" rel="noopener noreferrer" aria-label={`Open source page for ${latest.title}`}>Open source page</a>
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
                  <button className="link-button" type="button" onClick={() => requestRefill(entry.url)} aria-label={`Prepare ${entry.title} again`}>Again</button>
                  <a className="link-button" href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={`Open source page for ${entry.title}`}>Open</a>
                  <button className="link-button danger" type="button" onClick={() => removeHistoryEntry(entry.id)} aria-label={`Remove ${entry.title} from history`}>Remove</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
