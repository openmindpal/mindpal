'use client';

import { useEffect } from 'react';

export function VitalsReporter() {
  useEffect(() => {
    import('@/shared/lib/vitals').then(({ initVitals }) => initVitals());
  }, []);
  return null;
}
