import type { Metadata } from "next";
import "./globals.css";
import ClientLayout from "./client-layout";

export const metadata: Metadata = {
  title: "Memento — AI Coding Memory",
  description: "A shared brain for your AI coding tools. Memento collects conversations, plans and memory files from Claude Code, Codex, Cursor, Obsidian and more — self-hosted, cross-device, searchable.",
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
