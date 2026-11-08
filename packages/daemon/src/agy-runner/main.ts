import { exit, main } from "./runner.js";

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    process.stderr.write(`\n⏹️ [收到系统终止信号 (${sig})，已主动停止 Antigravity 任务]\n\n`);
    void exit(130);
  });
}

main().then(exit, (e: unknown) => {
  process.stderr.write(`Error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  void exit(1);
});
