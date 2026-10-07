'use client';

import { requestInputFocus } from '../lib/history';

const PLATFORMS = [
  { key: 'youtube', label: 'YouTube' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
];

// Each chip is a shortcut, not a filter: it shows that site's example link in the
// field and moves the cursor there, so a first-time visitor knows what to paste.
export default function PlatformChips() {
  return (
    <div className="platform-chips" role="group" aria-label="Supported platforms - show an example link for a site">
      {PLATFORMS.map((platform) => (
        <button
          key={platform.key}
          className="platform-chip"
          type="button"
          aria-label={`Show a ${platform.label} link example`}
          onClick={() => requestInputFocus(platform.key)}
        >
          {platform.label}
        </button>
      ))}
    </div>
  );
}