import Link from "next/link";

/** The app's own 404 (the framework's default was an English white page). */
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div
          className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{ background: "var(--aurora-accent-soft)", color: "var(--aurora-accent)" }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
            <path d="M8.5 11h5" />
          </svg>
        </div>
        <div className="text-[13px] font-medium tracking-wide" style={{ color: "var(--aurora-fg4)" }}>
          404
        </div>
        <h1 className="mt-2 text-xl font-semibold" style={{ color: "var(--aurora-fg1)" }}>
          这个页面不存在
        </h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--aurora-fg3)" }}>
          链接可能已经失效，或者页面换了位置。
        </p>
        <div className="mt-6 flex items-center justify-center gap-2.5">
          <Link
            href="/ask"
            className="rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ background: "var(--aurora-accent)" }}
          >
            回到 AI 执事
          </Link>
          <Link
            href="/app"
            className="rounded-lg px-4 py-2 text-sm font-medium"
            style={{ color: "var(--aurora-fg2)", border: "1px solid var(--aurora-border)", background: "var(--aurora-surface-solid)" }}
          >
            全景总览
          </Link>
        </div>
      </div>
    </div>
  );
}
