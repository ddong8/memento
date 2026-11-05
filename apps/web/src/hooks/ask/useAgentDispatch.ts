"use client";

import { useCallback, useRef, useState } from "react";

export function useAgentDispatch() {
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const startDispatch = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;
    setIsStreaming(true);
    return ctrl;
  }, []);

  const finishDispatch = useCallback(() => {
    setIsStreaming(false);
    abortControllerRef.current = null;
  }, []);

  const abortDispatch = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  return {
    isStreaming,
    abortControllerRef,
    startDispatch,
    finishDispatch,
    abortDispatch,
  };
}
