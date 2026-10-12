import { emitDeepLinkTarget } from "../lib/deeplink";

export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string {
  if (path) {
    emitDeepLinkTarget(path);
    const cleaned = path.replace(/^[a-z0-9.+-]+:\/\/+/i, "/");
    if (/^\/login(?:[/?#]|$)/i.test(cleaned)) {
      return "/login";
    }
  }
  return "/";
}
