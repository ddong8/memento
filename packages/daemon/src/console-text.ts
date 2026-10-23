import { execFile } from "node:child_process";
import { TextDecoder } from "node:util";

/**
 * Windows PowerShell 5.1 and most console programs write the console's code page (936 / GBK on
 * Chinese Windows), not UTF-8, when their output goes to a pipe; read as UTF-8 their Chinese text
 * came out as "����λ��". Programs built on UTF-8 runtimes (Node, Python with UTF-8 mode) write
 * UTF-8, so the encoding is decided per line: UTF-8 when the line is valid UTF-8, the console code
 * page otherwise.
 */

const CODE_PAGES: Record<number, string> = {
  936: "gb18030",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1252: "windows-1252",
  437: "windows-1252",
  850: "windows-1252",
};

/** The TextDecoder label for a Windows code page, or null when it is UTF-8 or not supported. */
export function codePageEncoding(codePage: number): string | null {
  const label = CODE_PAGES[codePage];
  if (!label) return null;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return null; // a Node build without full ICU
  }
}

let consoleEncoding: Promise<string | null> | undefined;

/** The console code page's encoding on this Windows machine (asked once), null elsewhere. */
export function windowsConsoleEncoding(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  consoleEncoding ??= new Promise((resolve) => {
    execFile("cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, timeout: 5000 }, (err, out) => {
      // "Active code page: 936" / "活动代码页: 936"; the digits are ASCII in every language
      const cp = Number(/(\d+)\s*$/.exec(String(out ?? "").trim())?.[1]);
      resolve(err || !cp ? null : codePageEncoding(cp));
    });
  });
  return consoleEncoding;
}

const LF = 0x0a;
/** A line this long without a newline is passed on anyway, so progress output still streams. */
const MAX_PENDING = 64 * 1024;

/** Turns a byte stream into text one line at a time, each line in whichever encoding it is in. */
export class LineDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private readonly fallback: TextDecoder | null;

  constructor(fallbackEncoding: string | null) {
    this.fallback = fallbackEncoding ? new TextDecoder(fallbackEncoding) : null;
  }

  /** The text of every complete line in what has arrived so far. */
  push(bytes: Buffer): string {
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    // 0x0A never occurs inside a GBK, Big5, Shift-JIS or UTF-8 multi-byte character
    const end = this.pending.lastIndexOf(LF) + 1;
    if (end === 0) {
      return this.pending.length > MAX_PENDING ? this.flush() : "";
    }
    const done = this.pending.subarray(0, end);
    this.pending = Buffer.from(this.pending.subarray(end));
    let text = "";
    let start = 0;
    while (start < done.length) {
      const nl = done.indexOf(LF, start) + 1;
      text += this.decodeLine(done.subarray(start, nl));
      start = nl;
    }
    return text;
  }

  /** Whatever is left once the stream has ended. */
  flush(): string {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest.length ? this.decodeLine(rest) : "";
  }

  private decodeLine(line: Uint8Array): string {
    try {
      return this.utf8.decode(line);
    } catch {
      return this.fallback ? this.fallback.decode(line) : new TextDecoder("utf-8").decode(line);
    }
  }
}
