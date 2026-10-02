import Link from 'next/link';
import Downloader from '../components/Downloader';
import HistoryPanel from '../components/HistoryPanel';

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
    <main className="site-shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="KOMYOSYS home">
          <span className="brand-mark">K</span>
          <span>KOMYOSYS</span>
        </Link>
      </header>

      <section className="hero-grid" aria-labelledby="page-title">
        <div className="hero-copy">
          <h1 id="page-title" className="hero-title">Video downloader</h1>
          <p className="hero-description">Paste a public link and choose video or audio.</p>
          <p className="supported-platforms">YouTube <span>·</span> TikTok <span>·</span> Instagram <span>·</span> Facebook</p>
        </div>
        <Downloader />
      </section>

      <HistoryPanel />

    </main>
  );
}