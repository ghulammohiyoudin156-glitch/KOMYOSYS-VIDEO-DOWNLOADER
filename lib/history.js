// Tiny framework-free store for "what did I download here?" - kept in the browser
// (localStorage) so nothing leaves the machine and the server stays stateless.
const STORAGE_KEY = 'komyosys.history.v1';
const MAX_ENTRIES = 24;

export const PLATFORM_META = {
  youtube: { name: 'YouTube', initial: 'Y', accent: '#ff6a5e' },
  facebook: { name: 'Facebook', initial: 'f', accent: '#6ba2ff' },
  instagram: { name: 'Instagram', initial: 'I', accent: '#e08cd6' },
  tiktok: { name: 'TikTok', initial: 'T', accent: '#ff3b5c' },
  other: { name: 'Saved link', initial: 'K', accent: '#4ad8b4' },
};

const listeners = new Set();
const refillListeners = new Set();

export const metaOf = (platform) => PLATFORM_META[platform] || PLATFORM_META.other;

const hasStorage = () => typeof window !== 'undefined' && !!window.localStorage;

const hasWindow = () => typeof window !== 'undefined';

const saneEntry = (entry) => (
  entry && typeof entry === 'object'
  && typeof entry.url === 'string' && entry.url.startsWith('http')
  && typeof entry.title === 'string' && entry.title.trim()
  && typeof entry.at === 'string'
);

// Old rows (or hand-edited storage) get filled in so every card and button works.
const normalizeEntry = (entry) => ({
  id: typeof entry.id === 'string' && entry.id ? entry.id : `legacy-${entry.url.slice(-24)}`,
  url: entry.url,
  title: entry.title.slice(0, 160),
  platform: typeof entry.platform === 'string' ? entry.platform : 'other',
  filename: typeof entry.filename === 'string' ? entry.filename : '',
  thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : '',
  duration: Number(entry.duration) || 0,
  quality: typeof entry.quality === 'string' ? entry.quality : '',
  sizeText: typeof entry.sizeText === 'string' ? entry.sizeText : '',
  sizeBytes: Number(entry.sizeBytes) || 0,
  // Remembered so a history card can label an audio save as audio instead of guessing
  // from the file name. Missing on older rows, so it stays optional.
  kind: entry.kind === 'audio' ? 'audio' : 'video',
  at: entry.at,
});

export function loadHistory() {
  if (!hasStorage()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(saneEntry).slice(0, MAX_ENTRIES).map(normalizeEntry);
  } catch {
    return [];
  }
}

function persist(entries) {
  if (!hasStorage()) return entries;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Private mode or a full quota - the page still works, it just forgets.
  }
  return entries;
}

function notify() {
  const entries = loadHistory();
  listeners.forEach((listener) => listener(entries));
  return entries;
}

// Newest first, and a repeated link refreshes its row instead of stacking a second one.
export function addHistoryEntry(entry) {
  const rest = loadHistory().filter((item) => item.url !== entry.url);
  persist([entry, ...rest].slice(0, MAX_ENTRIES));
  return notify();
}

export function removeHistoryEntry(id) {
  persist(loadHistory().filter((item) => item.id !== id));
  return notify();
}

export function clearHistory() {
  persist([]);
  return notify();
}

export function subscribeHistory(listener) {
  listeners.add(listener);
  // The "storage" event fires only in *other* tabs, which keeps them in sync.
  const onStorage = (event) => {
    if (event.key === null || event.key === STORAGE_KEY) listener(loadHistory());
  };
  if (hasWindow()) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (hasWindow()) window.removeEventListener('storage', onStorage);
  };
}

// Lets a history row hand its link back to the input box.
export function requestRefill(url) {
  refillListeners.forEach((listener) => listener(url));
}

export function subscribeRefill(listener) {
  refillListeners.add(listener);
  return () => refillListeners.delete(listener);
}

export function formatRelative(iso, now = Date.now()) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'recently';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hrs'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}
