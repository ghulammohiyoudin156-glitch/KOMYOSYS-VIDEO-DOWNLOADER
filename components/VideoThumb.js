'use client';

import { useState } from 'react';
import Image from 'next/image';
import { metaOf } from '../lib/history';

// Platform art when the source never gave us a thumbnail (or the image is gone).
export default function VideoThumb({ entry, className }) {
  const [broken, setBroken] = useState(false);
  const meta = metaOf(entry.platform);

  if (!entry.thumbnail || broken) {
    return (
      <div className={`${className} thumb-fallback`} style={{ '--accent': meta.accent }} aria-hidden="true">
        {meta.initial}
      </div>
    );
  }
  return (
    <Image
      className={className}
      src={entry.thumbnail}
      alt=""
      width={640}
      height={360}
      loading="lazy"
      unoptimized
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}
