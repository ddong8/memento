const PROGRESS_RE = /拉取成片 (\d+)%（(\d+)\/(\d+) MB，([\d.]+) MB\/s，约剩 (\d+) 分 (\d+) 秒）/;

/** 从代理回报的日志里取最近一条拉取进度（Mac 每过约 10% 回报一次）。 */
export function parseDownloadProgress(logs: string[]) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const m = PROGRESS_RE.exec(logs[i]);
    if (m) {
      return {
        percent: Number(m[1]),
        doneMb: Number(m[2]),
        totalMb: Number(m[3]),
        speed: Number(m[4]),
        leftSec: Number(m[5]) * 60 + Number(m[6]),
      };
    }
  }
  return null;
}
