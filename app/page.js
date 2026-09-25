import Downloader from '../components/Downloader';

export const metadata = {
  title: 'KOMYOSYS Video Downloader',
  description: 'Check public Facebook and Instagram links for authorized access.',
};

export default function Home() {
  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="KOMYOSYS home">
          <span className="brand-mark">K</span>
          <span>KOMYOSYS / MEDIA DESK</span>
        </a>
        <span className="header-note">Responsible access only</span>
      </header>

      <section className="hero-grid" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow">Public media, prepared simply</p>
          <h1 id="page-title" className="hero-title">Your link.<br /><em>Your file.</em><br />No friction.</h1>
          <p className="hero-description">A focused way to prepare videos you are allowed to save from public Instagram and Facebook links.</p>
          <div className="signal-row" aria-label="Service principles">
            <span className="signal">Public links</span>
            <span className="signal">MP4 preferred</span>
            <span className="signal">No login bypass</span>
          </div>
        </div>
        <Downloader />
      </section>

      <footer className="site-footer">
        <p><strong>KOMYOSYS</strong> · Media utility for authorized downloads.</p>
        <p>Private accounts, DRM, and platform restrictions remain protected.</p>
      </footer>
    </main>
  );
}