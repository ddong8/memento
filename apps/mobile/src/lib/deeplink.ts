type DeepLinkListener = (targetPath: string) => void;

let pendingDeepLinkTarget: string | null = null;
const listeners = new Set<DeepLinkListener>();

/**
 * Normalize any incoming deep link URL (from Dynamic Island widgetURL, custom scheme, or push notification)
 * into a clean internal web path such as `/ask?id=<uuid>&scroll=bottom`.
 */
export function normalizeDeepLinkTarget(rawUrl?: string | null): string | null {
  if (!rawUrl) return null;
  let target = rawUrl.trim();
  if (!target) return null;

  // 1. Handle query-wrapped root deep links: memento:///?target=%2Fask%3Fid%3D... or /?target=...
  const targetParamMatch = target.match(/[?&]target=([^&#]+)/i);
  if (targetParamMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(targetParamMatch[1]).trim();
      if (decoded) {
        return decoded.startsWith("/") || decoded.startsWith("http") ? decoded : `/${decoded}`;
      }
    } catch {
      // fallback to standard parsing below
    }
  }

  // 2. Strip custom URL schemes: memento://ask?id=... -> /ask?id=...
  if (/^(?:memento|com\.ihasy\.memento):\/\//i.test(target)) {
    target = target.replace(/^(?:memento|com\.ihasy\.memento):\/+/i, "/");
  }

  if (!target || target === "/" || /^\/?(?:index|\+not-found)(?:[/?#]|$)/i.test(target)) {
    return null;
  }

  if (!target.startsWith("/") && !target.startsWith("http")) {
    target = `/${target}`;
  }

  return target;
}

export interface DeepLinkAction {
  action?: "cancel" | string;
  conversationId?: string;
  targetPath?: string;
}

export function parseDeepLinkAction(rawUrl?: string | null): DeepLinkAction | null {
  if (!rawUrl) return null;
  const str = rawUrl.trim();
  const actionMatch = str.match(/[?&]action=([^&#]+)/i);
  const idMatch = str.match(/[?&](?:conversationId|id)=([^&#]+)/i);
  if (!actionMatch && !idMatch) return null;
  return {
    action: actionMatch?.[1]?.toLowerCase(),
    conversationId: idMatch?.[1],
    targetPath: normalizeDeepLinkTarget(rawUrl) || undefined,
  };
}

export function emitDeepLinkTarget(rawUrl?: string | null): string | null {
  const normalized = normalizeDeepLinkTarget(rawUrl);
  if (!normalized || /^\/login(?:[/?#]|$)/i.test(normalized)) {
    return null;
  }
  if (listeners.size > 0) {
    for (const listener of listeners) {
      listener(normalized);
    }
  } else {
    pendingDeepLinkTarget = normalized;
  }
  return normalized;
}

export function consumePendingDeepLinkTarget(): string | null {
  const val = pendingDeepLinkTarget;
  pendingDeepLinkTarget = null;
  return val;
}

export function subscribeDeepLinkTarget(listener: DeepLinkListener): () => void {
  listeners.add(listener);
  if (pendingDeepLinkTarget) {
    const val = pendingDeepLinkTarget;
    pendingDeepLinkTarget = null;
    listener(val);
  }
  return () => {
    listeners.delete(listener);
  };
}
