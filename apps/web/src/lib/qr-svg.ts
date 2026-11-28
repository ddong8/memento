// Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, Versions 1..15, ECC Level L / M).
// Produces crisp SVG markup for standalone desktop <-> mobile QR pairing without external CDNs.

export type QrEccLevel = "L" | "M";

interface VersionSpec {
  version: number;
  totalCodewords: number;
  /** Group specs: [blockCount, dataCodewordsPerBlock, ecCodewordsPerBlock] */
  groups: ReadonlyArray<readonly [number, number, number]>;
}

// ISO/IEC 18004 Table 9 — exact block definitions for ECC-L and ECC-M, Versions 1..15
const SPECS_L: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, groups: [[1, 19, 7]] },
  { version: 2, totalCodewords: 44, groups: [[1, 34, 10]] },
  { version: 3, totalCodewords: 70, groups: [[1, 55, 15]] },
  { version: 4, totalCodewords: 100, groups: [[1, 80, 20]] },
  { version: 5, totalCodewords: 134, groups: [[1, 108, 26]] },
  { version: 6, totalCodewords: 172, groups: [[2, 68, 18]] },
  { version: 7, totalCodewords: 196, groups: [[2, 78, 20]] },
  { version: 8, totalCodewords: 242, groups: [[2, 97, 24]] },
  { version: 9, totalCodewords: 292, groups: [[2, 116, 30]] },
  { version: 10, totalCodewords: 346, groups: [[2, 68, 18], [2, 69, 18]] },
  { version: 11, totalCodewords: 404, groups: [[4, 81, 20]] },
  { version: 12, totalCodewords: 466, groups: [[2, 92, 24], [2, 93, 24]] },
  { version: 13, totalCodewords: 532, groups: [[4, 107, 26]] },
  { version: 14, totalCodewords: 581, groups: [[3, 115, 30], [1, 116, 30]] },
  { version: 15, totalCodewords: 655, groups: [[5, 87, 22], [1, 88, 22]] },
];

const SPECS_M: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, groups: [[1, 16, 10]] },
  { version: 2, totalCodewords: 44, groups: [[1, 28, 16]] },
  { version: 3, totalCodewords: 70, groups: [[1, 44, 26]] },
  { version: 4, totalCodewords: 100, groups: [[2, 32, 18]] },
  { version: 5, totalCodewords: 134, groups: [[2, 43, 24]] },
  { version: 6, totalCodewords: 172, groups: [[4, 27, 16]] },
  { version: 7, totalCodewords: 196, groups: [[4, 31, 18]] },
  { version: 8, totalCodewords: 242, groups: [[2, 38, 22], [2, 39, 22]] },
  { version: 9, totalCodewords: 292, groups: [[3, 36, 22], [2, 37, 22]] },
  { version: 10, totalCodewords: 346, groups: [[4, 43, 26], [1, 44, 26]] },
  { version: 11, totalCodewords: 404, groups: [[1, 50, 30], [4, 51, 30]] },
  { version: 12, totalCodewords: 466, groups: [[6, 36, 22], [2, 37, 22]] },
  { version: 13, totalCodewords: 532, groups: [[8, 37, 22], [1, 38, 22]] },
  { version: 14, totalCodewords: 581, groups: [[4, 40, 24], [5, 41, 24]] },
  { version: 15, totalCodewords: 655, groups: [[5, 41, 24], [5, 42, 24]] },
];

// Alignment pattern center positions per version (ISO/IEC 18004 Annex E)
const ALIGN_POS: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
];

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j]! ^ poly[j]!) & 0xff;
      next[j + 1] = (next[j + 1]! ^ gfMul(poly[j]!, root)) & 0xff;
    }
    poly = next;
  }
  return poly;
}

export function rsComputeRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        rem[j] = (rem[j]! ^ gfMul(gen[j + 1]!, factor)) & 0xff;
      }
    }
  }
  return rem;
}

function totalDataCapacity(spec: VersionSpec): number {
  let sum = 0;
  for (const [cnt, dc] of spec.groups) sum += cnt * dc;
  return sum;
}

function encodeFormatBits(ecc: QrEccLevel, mask: number): number {
  // Format indicators: L = 01 (1), M = 00 (0)
  const eccBits = ecc === "L" ? 1 : 0;
  const data = (eccBits << 3) | (mask & 7);
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((rem >> (i + 10)) & 1) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function encodeVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((rem >> (i + 12)) & 1) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

export interface QrMatrix {
  version: number;
  size: number;
  modules: Uint8Array;
}

function buildCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const cap = totalDataCapacity(spec);
  const countBits = spec.version <= 9 ? 8 : 16;
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  // Mode indicator 0100 (Byte)
  pushBits(0b0100, 4);
  pushBits(bytes.length, countBits);
  for (const b of bytes) pushBits(b, 8);

  const capBits = cap * 8;
  const term = Math.min(4, capBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(cap);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]!;
    data[i] = byte;
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  for (let i = bits.length / 8; i < cap; i++) {
    data[i] = padBytes[padIdx % 2]!;
    padIdx++;
  }

  // Split into RS blocks and interleave data + EC codewords
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  let maxDataLen = 0;
  let ecLen = 0;
  for (const [count, dc, ec] of spec.groups) {
    ecLen = ec;
    if (dc > maxDataLen) maxDataLen = dc;
    for (let b = 0; b < count; b++) {
      const blk = data.subarray(offset, offset + dc);
      offset += dc;
      dataBlocks.push(blk);
      ecBlocks.push(rsComputeRemainder(blk, ec));
    }
  }

  const out = new Uint8Array(spec.totalCodewords);
  let pos = 0;
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) out[pos++] = blk[i]!;
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const ecBlk of ecBlocks) {
      out[pos++] = ecBlk[i]!;
    }
  }
  return out;
}

function drawFunctionPatterns(version: number, size: number): { modules: Uint8Array; isFunc: Uint8Array } {
  const modules = new Uint8Array(size * size);
  const isFunc = new Uint8Array(size * size);
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r * size + c] = dark ? 1 : 0;
    isFunc[r * size + c] = 1;
  };

  // Timing patterns
  for (let i = 0; i < size; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Finder patterns + 1-module white separator
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const dark =
          dr >= 0 &&
          dr <= 6 &&
          dc >= 0 &&
          dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(top + dr, left + dc, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  const centers = ALIGN_POS[version] ?? [];
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      const isCorner =
        (i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0);
      if (isCorner) continue;
      const cr = centers[i]!;
      const cc = centers[j]!;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info areas & dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) setFunc(8, size - 1 - i, false);
  for (let i = 0; i < 7; i++) setFunc(size - 1 - i, 8, false);
  setFunc(size - 8, 8, true); // always dark

  // Version info areas (Version >= 7)
  if (version >= 7) {
    const vBits = encodeVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  return { modules, isFunc };
}

function writeFormatInfo(modules: Uint8Array, size: number, ecc: QrEccLevel, mask: number): void {
  const bits = encodeFormatBits(ecc, mask);
  const put = (r: number, c: number, bitIdx: number) => {
    modules[r * size + c] = (bits >> bitIdx) & 1;
  };
  for (let i = 0; i <= 5; i++) put(8, i, 14 - i);
  put(8, 7, 8);
  put(8, 8, 7);
  put(7, 8, 6);
  for (let i = 0; i <= 5; i++) put(5 - i, 8, 5 - i);

  for (let i = 0; i < 7; i++) put(size - 1 - i, 8, 14 - i);
  for (let i = 0; i < 8; i++) put(8, size - 8 + i, 7 - i);
}

function penaltyScore(modules: Uint8Array, size: number): number {
  let score = 0;
  // Rule 1: adjacent runs >= 5
  for (let r = 0; r < size; r++) {
    let runColor = modules[r * size]!;
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      const cur = modules[r * size + c]!;
      if (cur === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = cur;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[c]!;
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      const cur = modules[r * size + c]!;
      if (cur === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = cur;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r * size + c]!;
      if (v === modules[r * size + c + 1] && v === modules[(r + 1) * size + c] && v === modules[(r + 1) * size + c + 1]) {
        score += 3;
      }
    }
  }
  // Rule 4: dark ratio balance
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i]!;
  const k = Math.floor(Math.abs((dark * 100) / modules.length - 50) / 5);
  score += k * 10;
  return score;
}

/** Encode arbitrary UTF-8 text into an ISO/IEC 18004 QR matrix (Versions 1..15). */
export function encodeQrMatrix(text: string, ecc: QrEccLevel = "L"): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const table = ecc === "M" ? SPECS_M : SPECS_L;
  const spec = table.find((s) => {
    const cap = totalDataCapacity(s);
    const headerBits = 4 + (s.version <= 9 ? 8 : 16);
    return Math.ceil((headerBits + bytes.length * 8) / 8) <= cap;
  });
  if (!spec) {
    throw new Error(`QR payload too long (${bytes.length} bytes)`);
  }

  const size = spec.version * 4 + 17;
  const codewords = buildCodewords(bytes, spec);
  const { modules: base, isFunc } = drawFunctionPatterns(spec.version, size);

  // Place codeword bits in standard 2-column upward/downward zigzag skipping column 6
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        const idx = r * size + c;
        if (isFunc[idx]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3]! >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        base[idx] = bit;
      }
    }
  }

  // Evaluate all 8 mask patterns and choose the lowest penalty
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestModules = new Uint8Array(size * size);
  for (let mask = 0; mask < 8; mask++) {
    const cand = new Uint8Array(base);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const idx = r * size + c;
        if (!isFunc[idx] && maskBit(mask, r, c)) {
          cand[idx] = cand[idx]! ^ 1;
        }
      }
    }
    writeFormatInfo(cand, size, ecc, mask);
    const sc = penaltyScore(cand, size);
    if (sc < bestScore) {
      bestScore = sc;
      bestMask = mask;
      bestModules = cand;
    }
  }
  void bestMask;
  return { version: spec.version, size, modules: bestModules };
}

/** Render a UTF-8 string as a crisp, self-contained SVG QR code with quiet zone. */
export function encodeQrSvg(text: string, opts: { ecc?: QrEccLevel; quietZone?: number; fg?: string; bg?: string } = {}): string {
  const qr = encodeQrMatrix(text, opts.ecc ?? "L");
  const qz = opts.quietZone ?? 4;
  const fg = opts.fg ?? "#14121E";
  const bg = opts.bg ?? "#FFFFFF";
  const viewSize = qr.size + qz * 2;
  const parts: string[] = [];
  for (let r = 0; r < qr.size; r++) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.modules[r * qr.size + c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < qr.size && qr.modules[r * qr.size + c]) c++;
      parts.push(`M${start + qz},${r + qz}h${c - start}v1h-${c - start}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><rect width="${viewSize}" height="${viewSize}" fill="${bg}"/><path d="${parts.join("")}" fill="${fg}"/></svg>`;
}
