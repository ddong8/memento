"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/aurora/Icon";
import { useAuth } from "@/lib/auth-context";

/**
 * Pages anyone may open (privacy policy, help): signed in they sit in the app's own shell like any
 * other page; signed out (the login page's links, an App Store reviewer) the shell isn't there, so
 * this gives them the brand bar and page margins instead of text flush against the window edge.
 */
export function PublicPageFrame({ children }: { children: ReactNode }) {
  const { token, loading } = useAuth();
  if (token || loading) return <>{children}</>;
  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-10 flex h-14 items-center justify-between px-5 sm:px-8"
        style={{
          borderBottom: "1px solid var(--aurora-border)",
          background: "color-mix(in srgb, var(--aurora-bg) 82%, transparent)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{ background: "var(--aurora-brand-grad)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.28)" }}
          >
            <Icon name="sparkles" size={14} strokeWidth={2} style={{ color: "#fff" }} />
          </span>
          <span className="text-[14px] font-semibold tracking-tight" style={{ color: "var(--aurora-fg1)" }}>
            Memento
          </span>
        </Link>
        <Link
          href="/auth/login"
          className="rounded-[10px] px-3 py-1.5 text-[13px] font-medium"
          style={{ background: "var(--aurora-accent)", color: "#fff" }}
        >
          登录
        </Link>
      </header>
      <div className="px-5 pt-6 sm:px-8 sm:pt-10">{children}</div>
    </div>
  );
}
