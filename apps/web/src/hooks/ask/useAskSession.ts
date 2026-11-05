"use client";

import { useCallback, useState } from "react";
import type { AskConversationSummary } from "@/lib/api-client";

export interface UseAskSessionOptions {
  onNewChat?: () => void;
  onSelectConversation?: (conv: AskConversationSummary) => void;
}

export function useAskSession(initialId: string | null = null, initialTitle = "新对话") {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(initialId);
  const [displayConvTitle, setDisplayConvTitle] = useState<string>(initialTitle);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);

  const startNewConversation = useCallback(() => {
    setActiveConversationId(null);
    setDisplayConvTitle("新对话");
    setIsRestoring(false);
  }, []);

  const switchConversation = useCallback((convId: string, title?: string) => {
    setActiveConversationId(convId);
    if (title) {
      setDisplayConvTitle(title);
    }
  }, []);

  const updateTitle = useCallback((newTitle: string) => {
    if (newTitle && newTitle.trim()) {
      setDisplayConvTitle(newTitle.trim());
    }
  }, []);

  return {
    activeConversationId,
    setActiveConversationId,
    displayConvTitle,
    setDisplayConvTitle,
    isRestoring,
    setIsRestoring,
    startNewConversation,
    switchConversation,
    updateTitle,
  };
}
