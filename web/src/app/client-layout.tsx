"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { DeviceProvider } from "@/lib/device-context";
import { ThemeProvider } from "@/lib/theme-context";
import { I18nContext, locales, type Locale } from "@/lib/i18n";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import { AuroraBackdrop } from "@/components/aurora/AuroraBackdrop";
import CommandPalette from "@/components/CommandPalette";

/** Detect the best initial locale: user's saved choice → browser preference → zh-CN default. */
function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "zh-CN";
  const saved = localStorage.getItem("dr_locale") as Locale | null;
  if (saved && saved in locales) return saved;
  // Browser preference. navigator.languages is ordered by priority.
  const prefs = (navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || ""]);
  for (const p of prefs) {
    const lower = p.toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("en")) return "en-US";
  }
  return "zh-CN";
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  // Lazy init: first saved choice, else browser pref, else zh-CN. Avoids
  // setState-in-effect cascading render.
  const [locale, setLocale] = useState<Locale>(detectInitialLocale);
  const t = locales[locale].translations;
  const pathname = usePathname();

  const handleSetLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem("dr_locale", l);
  };

  // Server metadata (layout.tsx) hard-codes English tab title since it can't
  // read locale. On every route change, Next.js App Router re-applies the
  // layout metadata — including the English title — which clobbers whatever
  // we set on mount. Re-assert on every locale AND pathname change.
  useEffect(() => {
    document.title = `${t.app.title} — ${t.app.subtitle}`;
    document.documentElement.lang = locale === "zh-CN" ? "zh" : "en";
  }, [locale, t.app.title, t.app.subtitle, pathname]);

  return (
    <ThemeProvider>
      <I18nContext.Provider value={{ locale, t, setLocale: handleSetLocale }}>
        <AuthProvider>
          <AuroraBackdrop />
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </I18nContext.Provider>
    </ThemeProvider>
  );
}

import { SidebarProvider, useSidebar } from "@/lib/sidebar-context";

function AppShellInner({
  sidebarOpen,
  setSidebarOpen,
  children,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  children: React.ReactNode;
}) {
  const { collapsed } = useSidebar();

  return (
    <div className="min-h-screen">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className={`transition-all duration-200 ${collapsed ? "lg:ml-[68px]" : "lg:ml-60"} relative z-0`}>
        <Header onMenuToggle={() => setSidebarOpen((v) => !v)} />
        <main className="pt-20 px-4 pb-4 md:px-6 md:pb-6">{children}</main>
      </div>
    </div>
  );
}

/** Renders Sidebar+Header only inside the authenticated app; the public
 *  landing page ("/") and auth pages always use plain layout. */
function AppShell({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as unknown as { __memento_client_push?: (path: string) => void }).__memento_client_push = (path: string) => {
        router.push(path);
      };
    }
    return () => {
      if (typeof window !== "undefined") {
        delete (window as unknown as { __memento_client_push?: unknown }).__memento_client_push;
      }
    };
  }, [router]);

  // Save current route for seamless session restoration on reopening
  useEffect(() => {
    if (typeof window === "undefined" || !pathname) return;
    const isPublic = pathname === "/" || pathname.startsWith("/auth/") || pathname.startsWith("/s/");
    if (!isPublic) {
      try {
        const full = window.location.pathname + window.location.search;
        localStorage.setItem("memento_last_route", full);
      } catch {}
    }
  }, [pathname]);

  // Always plain layout for the marketing landing page — its own nav is
  // rendered by the landing component itself.
  const isLanding = pathname === "/";
  // Public share pages are read-only and shouldn't show the app sidebar
  // (visitors have no account; the sidebar wouldn't work anyway).
  const isSharePage = pathname.startsWith("/s/") || pathname === "/s";

  if (isLanding || isSharePage || loading || !token) {
    return <main className="min-h-screen">{children}</main>;
  }

  return (
    <SidebarProvider>
      <DeviceProvider>
        {/* Global Cmd/Ctrl+K search. Inside DeviceProvider (it reads the device
            filter) and inside the authed branch, so it never mounts on the
            landing or public share pages. */}
        <CommandPalette />
        <AppShellInner sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}>
          {children}
        </AppShellInner>
      </DeviceProvider>
    </SidebarProvider>
  );
}
