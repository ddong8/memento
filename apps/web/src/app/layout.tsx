import type { Metadata, Viewport } from "next";
import "./globals.css";
import ClientLayout from "./client-layout";

// Without this, Next.js 16 omits <meta name="viewport">, so iOS Safari and
// Android Chrome render at ~980px desktop width and then scale to fit —
// every page looks oversized and text tiny on phones.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

// SSR default is zh-CN because Next.js App Router re-asserts this static
// metadata on every client-side navigation, overriding any document.title we
// set in a client useEffect. English users' client-side locale hook still
// rewrites to English on mount — the cost is one frame of Chinese title.
export const metadata: Metadata = {
  title: "Memento — AI 编程记忆",
  description: "统一收纳 Claude Code、Codex、Cursor、Obsidian 等 AI 编码工具的对话、计划与记忆文件,自建托管,跨设备可搜。A shared brain for your AI coding tools — self-hosted, cross-device, searchable.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png" },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className="h-full antialiased">
      <body className="min-h-full">
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
