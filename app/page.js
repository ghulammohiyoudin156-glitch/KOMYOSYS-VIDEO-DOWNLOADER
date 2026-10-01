import Link from 'next/link';
import Downloader from '../components/Downloader';
import HistoryPanel from '../components/HistoryPanel';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://komyosys-video-downloader.vercel.app';

export const metadata = {
  metadataBase: new URL(BASE_URL),
  title: 'KOMYOSYS Video Downloader',
  description: 'Turn public YouTube, TikTok, Instagram, and Facebook video links into a downloadable file, with a private history of what you saved.',
  // Without these the tab shows the raw route and any share/link preview is blank.
  openGraph: {
    title: 'KOMYOSYS Video Downloader',
    description: 'Turn public YouTube, TikTok, Instagram, and Facebook video links into a downloadable file.',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'KOMYOSYS Video Downloader',
    description: 'Save public YouTube, TikTok, Instagram, and Facebook videos.',
  },
  robots: { index: true, follow: true },
};

export default function Home() {
  return (
    <main className="site-shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="KOMYOSYS home">
          <span className="brand-mark">K</span>
          <span>KOMYOSYS / MEDIA DESK</span>
        </Link>
        <span className="header-note">Responsible access only</span>
      </header>

      <section className="hero-grid" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow">Public media, prepared simply</p>
          <h1 id="page-title" className="hero-title">Your link.<br /><em>Your file.</em><br />No friction.</h1>
          <p className="hero-description">A focused way to prepare videos you are allowed to save from public YouTube, TikTok, Instagram, and Facebook links.</p>
          <div className="signal-row" aria-label="Service principles">
            <span className="signal">YouTube + TikTok + IG + FB</span>
            <span className="signal">Public links</span>
            <span className="signal">MP4 or MP3</span>
            <span className="signal">No login bypass</span>
          </div>
        </div>
        <Downloader />
      </section>

      <HistoryPanel />

      <footer className="site-footer">
        <p><strong>KOMYOSYS</strong> · Media utility for authorized downloads.</p>
        <p>Private accounts, DRM, and platform restrictions remain protected.</p>
      </footer>
    </main>
  );
}