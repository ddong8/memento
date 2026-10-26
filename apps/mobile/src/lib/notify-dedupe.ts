/**
 * One notification reaches the phone several ways (APNs, Expo push, the feed poll, the web bridge);
 * whichever comes first is shown and the rest within the window are dropped, by id or by title + body.
 */
export function createNotifyDedupe(windowMs = 60_000, now: () => number = Date.now) {
  const notified = new Map<string, number>();
  const key = (title?: string | null, body?: string | null) => `${(title || "").trim()}:::${(body || "").trim()}`;
  const fresh = (k: string, t: number) => {
    const at = notified.get(k);
    return at !== undefined && t - at < windowMs;
  };

  function isRecentlyNotified(title?: string | null, body?: string | null, id?: string | null): boolean {
    const t = now();
    return Boolean(id && fresh(`id:${id}`, t)) || fresh(key(title, body), t);
  }

  function markAsNotified(title?: string | null, body?: string | null, id?: string | null): void {
    const t = now();
    notified.set(key(title, body), t);
    if (id) notified.set(`id:${id}`, t);
    for (const [k, at] of notified.entries()) {
      if (t - at > windowMs * 2) notified.delete(k);
    }
  }

  return { isRecentlyNotified, markAsNotified };
}
