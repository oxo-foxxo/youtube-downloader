import { useEffect, useState } from 'react';
import type { ApiClient } from '../api.js';

export function useStorage(api: ApiClient) {
  const [freeBytes, setFreeBytes] = useState<number>();
  useEffect(() => {
    if (!api.storage) return;
    let active = true;
    const refresh = async () => {
      try {
        const storage = await api.storage!();
        if (active) setFreeBytes(storage.availableBytes);
      } catch {
        if (active) setFreeBytes(undefined);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  return freeBytes;
}
