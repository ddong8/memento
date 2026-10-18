"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { getApiBase } from "./api-client";

export interface SSEEvent {
  type: string;
  data: {
    document_id?: string;
    tool_id?: string;
    category?: string;
    relative_path?: string;
    title?: string;
  };
  timestamp: number;
}

/**
 * Hook that subscribes to the SSE event stream.
 * Calls `onEvent` whenever a new file_synced event arrives.
 * Auto-reconnects on disconnect.
 */
export function useSSE(onEvent: (event: SSEEvent) => void) {
  const onEventRef = useRef(onEvent);
  // Sync the latest onEvent handler into ref AFTER render, not during.
  // This avoids the React 19 "refs during render" rule violation while
  // preserving the "always-fresh-callback" semantics inside the effect below.
  useLayoutEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const base = getApiBase();
      const token = localStorage.getItem("dr_token");
      if (!token) return; // Not logged in — don't connect SSE
      es = new EventSource(`${base}/api/events/stream?token=${encodeURIComponent(token)}`);

      es.addEventListener("file_synced", (e) => {
        try {
          const event: SSEEvent = JSON.parse(e.data);
          onEventRef.current(event);
        } catch {}
      });

      es.addEventListener("keepalive", () => {
        // ignore keepalives
      });

      es.onerror = () => {
        es?.close();
        // Reconnect after 5 seconds
        reconnectTimer = setTimeout(connect, 5000);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);
}
