import Link from 'next/link';
import Downloader from '../components/Downloader';
import HistoryPanel from '../components/HistoryPanel';
import PlatformChips from '../components/PlatformChips';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://komyosys-video-downloader.vercel.app';

export const metadata = {
  metadataBase: new URL(BASE_URL),
  title: 'KOMYOSYS Video Downloader',
  description: 'Prepare authorized video and audio downloads from public media links.',
  // Without these the tab shows the raw route and any share/link preview is blank.
  openGraph: {
    title: 'KOMYOSYS Video Downloader',
    description: 'Prepare authorized video and audio downloads from public media links.',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'KOMYOSYS Video Downloader',
    description: 'Prepare authorized video and audio downloads from public media links.',
  },
  robots: { index: true, follow: true },
};

export default function Home() {
  return (
    <main className="site-shell" id="main-content">
      {/* Keyboard users land here first instead of tabbing through the whole page. */}
      <a className="skip-link" href="#video-url">Skip to the download field</a>

      <header className="site-header">
        <Link className="brand" href="/" aria-label="KOMYOSYS home">
          <span className="brand-mark">K</span>
          <span>KOMYOSYS</span>
        </Link>
        <nav className="header-nav" aria-label="Page sections">
          <a href="#how-it-works">How it works</a>
          <a href="#faq">FAQ</a>
          <a href="#history-title">History</a>
        </nav>
      </header>

      <section className="hero-grid" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="brand-badge">
            <span className="brand-badge-dot" aria-hidden="true" />
            <span className="brand-badge-name">KOMYOSYS</span>
            <span className="brand-badge-sep" aria-hidden="true">•</span>
            Fast private downloader
          </p>
          <h1 id="page-title" className="hero-title">Video <em>downloader</em></h1>
          <p className="hero-description">Paste a public link and choose video or audio. Your file is prepared in one click and saved straight to this device.</p>

          {/* Trust bar stated as honest product facts - no invented reviews or counts. */}
          <ul className="hero-proof">
            <li><span className="proof-value">4</span><span className="proof-label">Platforms</span></li>
            <li><span className="proof-value">2</span><span className="proof-label">Formats</span></li>
            <li><span className="proof-value">10m</span><span className="proof-label">Auto-delete</span></li>
          </ul>

          <ul className="hero-benefits">
            <li>Fast downloads</li>
            <li>No sign-up</li>
            <li>Save to your device</li>
          </ul>

          <p className="supported-platforms-label">Supported platforms</p>
          <PlatformChips />
          <p className="platform-support-note">
            <span aria-hidden="true">✦</span>
            Paste any link - the platform is detected automatically, no settings needed.
          </p>
        </div>
        <Downloader />
      </section>

      {/* Compact strip that bridges the hero and the steps so the gap never reads as dead space. */}
      <section className="feature-strip" aria-label="Why KOMYOSYS">
        <ul className="feature-grid">
          <li className="feature-item feature-mint">
            <span className="feature-icon" aria-hidden="true">»</span>
            <div className="feature-body">
              <p className="feature-title">Fast downloads</p>
              <p className="feature-copy">Ready in a single click</p>
            </div>
          </li>
          <li className="feature-item feature-sky">
            <span className="feature-icon" aria-hidden="true">◉</span>
            <div className="feature-body">
              <p className="feature-title">Private</p>
              <p className="feature-copy">No sign-up required</p>
            </div>
          </li>
          <li className="feature-item feature-gold">
            <span className="feature-icon" aria-hidden="true">▣</span>
            <div className="feature-body">
              <p className="feature-title">MP4 / MP3</p>
              <p className="feature-copy">Video or audio only</p>
            </div>
          </li>
          <li className="feature-item feature-coral">
            <span className="feature-icon" aria-hidden="true">▤</span>
            <div className="feature-body">
              <p className="feature-title">Mobile friendly</p>
              <p className="feature-copy">Works on any screen</p>
            </div>
          </li>
        </ul>
      </section>

      <section className="how-section" id="how-it-works" aria-labelledby="how-title">
        <p className="eyebrow">Three simple steps</p>
        <h2 id="how-title" className="section-title">How it works</h2>
        <ol className="steps-grid">
          <li className="step-card">
            <span className="step-number" aria-hidden="true">1</span>
            <div className="step-body">
              <h3 className="step-title">Copy your link</h3>
              <p className="step-copy">Open the video on YouTube, TikTok, Instagram or Facebook and copy its share link.</p>
            </div>
            <span className="step-tag">Share menu</span>
          </li>
          <li className="step-card">
            <span className="step-number" aria-hidden="true">2</span>
            <div className="step-body">
              <h3 className="step-title">Paste and choose</h3>
              <p className="step-copy">Paste it in the field above, then pick the full video or audio only.</p>
            </div>
            <span className="step-tag">MP4 or MP3</span>
          </li>
          <li className="step-card">
            <span className="step-number" aria-hidden="true">3</span>
            <div className="step-body">
              <h3 className="step-title">Save the file</h3>
              <p className="step-copy">Watch the progress bar, then save the finished file to your device. It also lands in your history below.</p>
            </div>
            <span className="step-tag">On your device</span>
          </li>
        </ol>
      </section>

      <HistoryPanel />

      <section className="faq-section" id="faq" aria-labelledby="faq-title">
        <p className="eyebrow">Good to know</p>
        <h2 id="faq-title" className="section-title">Frequently asked questions</h2>
        <div className="faq-list">
          <details className="faq-item">
            <summary>Which platforms are supported?</summary>
            <p>YouTube, TikTok, Instagram and Facebook public links. Paste the link and the panel detects the platform automatically.</p>
          </details>
          <details className="faq-item">
            <summary>Do I need an account or an app?</summary>
            <p>No. Everything runs in your browser - no sign-up, no extension and no software to install.</p>
          </details>
          <details className="faq-item">
            <summary>Where are my downloads stored?</summary>
            <p>Your download history lives only in this browser on this device. Prepared files stay on the server for 10 minutes and are then removed automatically.</p>
          </details>
          <details className="faq-item">
            <summary>Why did my download fail?</summary>
            <p>Private posts, expired links or an unsupported URL can fail. If this host cannot run downloads, the error message includes a link to a working download site.</p>
          </details>
          <details className="faq-item">
            <summary>Is it legal to download a video?</summary>
            <p>Only download content you own or are authorized to save, and always respect the platform&apos;s terms and the creator&apos;s rights.</p>
          </details>
        </div>

        {/* Keeps the section from feeling isolated and sends stuck visitors back to the field. */}
        <aside className="faq-help">
          <span className="faq-help-icon" aria-hidden="true">?</span>
          <div className="faq-help-text">
            <p className="faq-help-title">Still need a hand?</p>
            <p className="faq-help-copy">Paste your link above and press Prepare - most links start within seconds. Your history stays in this browser only.</p>
          </div>
          <a className="faq-help-link" href="#video-url">Go to the download field ↑</a>
        </aside>
      </section>

      <footer className="site-footer">
        <div className="footer-inner">
          <Link className="brand" href="/" aria-label="KOMYOSYS home">
            <span className="brand-mark">K</span>
            <span>KOMYOSYS</span>
          </Link>
          <p className="footer-note">Only download content you own or are authorized to save.</p>
          <p className="footer-copy">© {new Date().getFullYear()} KOMYOSYS</p>
        </div>
      </footer>
    </main>
  );
}