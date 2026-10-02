import { useEffect, useRef } from 'react';

export type RealtimeEvent = { type: string; [key: string]: unknown };
const EVENT_NAME = 'skillswap-realtime-event';

export function useRealtimeEvent(type: string | string[], handler: (event: RealtimeEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  const key = Array.isArray(type) ? type.join('|') : type;
  useEffect(() => {
    const accepted = new Set(key.split('|'));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<RealtimeEvent>).detail;
      if (detail && accepted.has(detail.type)) latest.current(detail);
    };
    window.addEventListener(EVENT_NAME, listener);
    return () => window.removeEventListener(EVENT_NAME, listener);
  }, [key]);
}

export function emitRealtime(event: RealtimeEvent) {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: event }));
}
