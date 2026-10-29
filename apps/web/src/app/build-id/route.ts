// The build this server runs (the commit, next.config.ts): long-open windows compare it with their
// own and reload when a new one is deployed (src/lib/build-update.ts).
export function GET() {
  return new Response(process.env.MEMENTO_BUILD_ID ?? "", {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
