"use client";

import { memo, useEffect, useState } from "react";
import { AssistantBubble } from "@/components/ask/bubbles";
import type { Source, Turn } from "@/lib/ask/turns";

/** Isolated external store for the active streaming turn so token deltas don't re-render the whole page. */
export class ActiveStreamingTurnStore {
  private current: Turn | null = null;
  private listeners = new Set<(turn: Turn | null) => void>();

  get(): Turn | null {
    return this.current;
  }

  set(turn: Turn | null) {
    this.current = turn;
    for (const l of this.listeners) {
      l(turn);
    }
  }

  subscribe(listener: (turn: Turn | null) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const ActiveStreamingTurnBubble = memo(function ActiveStreamingTurnBubble({
  store,
  index,
  isReconnecting,
  prevUserCreatedAt,
  prevUserContent,
  onSourcesClick,
  onSmartCompactAndRetry,
  onShareTurn,
  pendingFollowUps,
  t,
}: {
  store: ActiveStreamingTurnStore;
  index: number;
  isReconnecting: boolean;
  prevUserCreatedAt?: string;
  prevUserContent?: string;
  onSourcesClick: (sources: Source[]) => void;
  onSmartCompactAndRetry: (sid?: string) => void;
  onShareTurn?: (index: number) => void;
  pendingFollowUps?: readonly string[];
  t: any;
}) {
  const [turn, setTurn] = useState<Turn | null>(() => store.get());

  useEffect(() => {
    return store.subscribe((newTurn) => {
      setTurn(newTurn ? { ...newTurn } : null);
    });
  }, [store]);

  if (!turn) return null;

  return (
    <div className="flex-1 min-w-0">
      <AssistantBubble
        index={index}
        turn={turn}
        isLast={true}
        streaming={true}
        isReconnecting={isReconnecting}
        prevUserCreatedAt={prevUserCreatedAt}
        prevUserContent={prevUserContent}
        onSourcesClick={onSourcesClick}
        onSmartCompactAndRetry={onSmartCompactAndRetry}
        onShareTurn={onShareTurn}
        pendingFollowUps={pendingFollowUps}
        t={t}
      />
    </div>
  );
});
