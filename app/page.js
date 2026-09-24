import Downloader from '../components/Downloader';

export const metadata = {
  title: 'KOMYOSYS Video Downloader',
  description: 'Check public Facebook and Instagram links for authorized access.',
};

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <Downloader />
    </main>
  );
}