"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { DeviceProvider } from "@/lib/device-context";
import { ThemeProvider } from "@/lib/theme-context";
import { I18nContext, locales, type Locale } from "@/lib/i18n";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";
import { AuroraBackdrop } from "@/components/aurora/AuroraBackdrop";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>("zh-CN");

  useEffect(() => {
    const saved = localStorage.getItem("dr_locale") as Locale | null;
    if (saved && saved in locales) setLocale(saved);
  }, []);

  const handleSetLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem("dr_locale", l);
  };

  return (
    <ThemeProvider>
      <I18nContext.Provider value={{ locale, t: locales[locale].translations, setLocale: handleSetLocale }}>
        <AuthProvider>
          <AuroraBackdrop />
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </I18nContext.Provider>
    </ThemeProvider>
  );
}

/** Renders Sidebar+Header only inside the authenticated app; the public
 *  landing page ("/") and auth pages always use plain layout. */
function AppShell({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  // Always plain layout for the marketing landing page — its own nav is
  // rendered by the landing component itself.
  const isLanding = pathname === "/";

  if (isLanding || loading || !token) {
    return <main className="min-h-screen">{children}</main>;
  }

  return (
    <DeviceProvider>
      <div className="min-h-screen">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="lg:ml-60 relative z-0">
          <Header onMenuToggle={() => setSidebarOpen((v) => !v)} />
          <main className="pt-20 px-4 pb-4 md:px-6 md:pb-6">{children}</main>
        </div>
      </div>
    </DeviceProvider>
  );
}
