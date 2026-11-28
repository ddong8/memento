import type { Metadata, Viewport } from "next";
import "./globals.css";
import ClientLayout from "./client-layout";
import { PLATFORM_SCRIPT } from "@/lib/platform-script";

// Without this, Next.js 16 omits <meta name="viewport">, so iOS Safari and
// Android Chrome render at ~980px desktop width and then scale to fit —
// every page looks oversized and text tiny on phones.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#15131F" },
  ],
};

// SSR default is zh-CN because Next.js App Router re-asserts this static
// metadata on every client-side navigation, overriding any document.title we
// set in a client useEffect. English users' client-side locale hook still
// rewrites to English on mount — the cost is one frame of Chinese title.
export const metadata: Metadata = {
  title: "Memento — 给你的 AI 工具建个共享大脑与全能工作台",
  description: "跨设备自动采集 Claude Code、Codex、Antigravity、Cursor、WorkBuddy 等 10+ AI 工具的对话与记忆；桌面端默认免 Docker 单机开箱即用，随时切换云端或私有化服务版，支持多机智能体协作与 iOS / Android 原生协同。",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Memento",
  },
  icons: {
    icon: [
      { url: "/favicon.svg?v=3", type: "image/svg+xml" },
      { url: "/favicon.png?v=3", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png?v=3", sizes: "180x180", type: "image/png" },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PLATFORM_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
