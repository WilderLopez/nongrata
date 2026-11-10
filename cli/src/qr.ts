// A small QR code encoder for `nongrata pair`, so the CLI keeps having no dependencies. Only what
// a pairing link needs (ISO/IEC 18004:2015): byte mode, error correction level M, versions 1 to
// 10 (up to 213 bytes), the mask with the lowest penalty, and output as Unicode half blocks.
// test/qr.test.ts checks it against matrices drawn by Apple's CoreImage and the standard's
// worked example.

export const MAX_VERSION = 10;

/** Level M, per version: EC codewords per block, and the blocks as [count, data codewords]. */
const BLOCKS: readonly { ec: number; groups: readonly (readonly [number, number])[] }[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];

/** Centre rows and columns of the alignment patterns, per version. */
const ALIGNMENT: readonly (readonly number[])[] = [
  // Stryker disable next-line ArrayDeclaration: version 1 has none; a single centre would be skipped as a finder corner anyway.
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
];

const blocksOf = (version: number) => BLOCKS[version - 1]!;

/** Data codewords of a version at level M. */
export const dataCapacity = (version: number): number =>
  blocksOf(version).groups.reduce((sum, [count, size]) => sum + count * size, 0);

/** Bits of the character count in byte mode: 8 up to version 9, 16 from 10. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

/** Bytes that fit in a version at level M. */
export const byteCapacity = (version: number): number =>
  Math.floor((dataCapacity(version) * 8 - 4 - countBits(version)) / 8);

// ---------------------------------------------------------------------------------------------
// Reed-Solomon over GF(256), with the polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).

export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Coefficients (highest first, without the leading 1) of the product of (x − α^i), i < degree. */
export function rsGenerator(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    // result[j + 1] is still the previous round's value; past the end it is 0.
    for (const j of result.keys()) result[j] = gfMultiply(result[j]!, root) ^ (result[j + 1] ?? 0);
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The `degree` error correction codewords of `data`: the remainder of data·x^degree ÷ generator. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const generator = rsGenerator(degree);
  const result = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (const i of result.keys()) result[i] ^= gfMultiply(generator[i]!, factor);
  }
  return [...result];
}

// ---------------------------------------------------------------------------------------------
// Codewords

/**
 * Mode, count, data, terminator and padding: exactly `dataCapacity(version)` codewords, for data
 * that fits. In byte mode there is always room for the whole 4-bit terminator, and mode, count,
 * data and terminator (8 + 8 or 16 + 8n bits) always end on a byte boundary.
 */
export function dataCodewords(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, countBits(version));
  for (const b of data) push(b, 8);
  push(0, 4);

  const capacity = dataCapacity(version) * 8;
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((w, bit) => (w << 1) | bit, 0));
  return words;
}

/** The data split into blocks, each with its EC codewords, interleaved as the symbol stores them. */
export function finalCodewords(data: readonly number[], version: number): number[] {
  const { ec, groups } = blocksOf(version);
  const blocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(offset, offset + size));
      offset += size;
    }
  }
  const result: number[] = [];
  // Data: the first codeword of every block, then the second… The longer blocks come last.
  for (const i of blocks[blocks.length - 1]!.keys()) for (const block of blocks) if (i < block.length) result.push(block[i]!);
  const ecBlocks = blocks.map((block) => rsRemainder(block, ec));
  for (const i of ecBlocks[0]!.keys()) for (const block of ecBlocks) result.push(block[i]!);
  return result;
}

// ---------------------------------------------------------------------------------------------
// The matrix. `modules[row][column]`, `true` is dark.

/** 15-bit format information for level M (00) and `mask`: BCH(15,5), then XOR 0x5412. */
export function formatBits(mask: number): number {
  let rem = mask;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((mask << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (versions 7 and up): BCH(18,6) with 0x1F25. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

// The ArithmeticOperator mutants disabled below turn a + b into a − b inside a test of parity
// (% 2 === 0), and a − b always has the parity of a + b.
const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  // Stryker disable next-line ArithmeticOperator: see above.
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  // Stryker disable next-line ArithmeticOperator: see above.
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  // Stryker disable next-line ArithmeticOperator: see above.
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  // Stryker disable next-line ArithmeticOperator: see above.
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

class Matrix {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  /** Finder, timing, alignment, format and version modules: not data, never masked. */
  readonly reserved: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    // Every module is written before it is read (function patterns, then every data position),
    // and a hole in `reserved` reads as false.
    // Stryker disable next-line ArrayDeclaration,BooleanLiteral: see above.
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    // Stryker disable next-line ArrayDeclaration: see above.
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private set(row: number, col: number, dark: boolean): void {
    this.modules[row]![col] = dark;
    this.reserved[row]![col] = true;
  }

  private drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    // Finders with their light separators. Both patterns are symmetric, so the disabled mutants
    // (centre − d instead of centre + d) draw the same thing; a write to column −1 sets a
    // property that nothing reads.
    for (const [row, col] of [
      [3, 3],
      [3, size - 4],
      [size - 4, 3],
    ] as const) {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          // Stryker disable next-line ArithmeticOperator: see above.
          const r = row + dr;
          // Stryker disable next-line ArithmeticOperator: see above.
          const c = col + dc;
          // Stryker disable next-line ConditionalExpression: see above.
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          this.set(r, c, ring !== 2 && ring !== 4);
        }
      }
    }
    // Alignment patterns, except the three that would overlap a finder.
    const centres = ALIGNMENT[this.version - 1]!;
    const last = centres.length - 1;
    centres.forEach((row, i) => {
      centres.forEach((col, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dr = -2; dr <= 2; dr++) {
          // Stryker disable next-line ArithmeticOperator: see above.
          for (let dc = -2; dc <= 2; dc++) this.set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      });
    });
    this.drawFormat(0); // reserves the area; drawn again with the chosen mask
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(b, a, bit(bits, i));
        this.set(a, b, bit(bits, i));
      }
    }
  }

  /** Both copies of the format information, and the dark module. */
  drawFormat(mask: number): void {
    const { size } = this;
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i++) this.set(i, 8, bit(bits, i));
    this.set(7, 8, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(8, 7, bit(bits, 8));
    // Stryker disable next-line EqualityOperator: i = 15 would write column −1, a property that nothing reads.
    for (let i = 9; i < 15; i++) this.set(8, 14 - i, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(8, size - 1 - i, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(size - 15 + i, 8, bit(bits, i));
    this.set(size - 8, 8, true);
  }

  /** The codewords, in two-column strips from the bottom right, up and down in turn. */
  drawCodewords(codewords: readonly number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          if (this.reserved[row]![col]) continue;
          // The remainder bits after the last codeword stay light (0).
          this.modules[row]![col] = bit(codewords[i >>> 3] ?? 0, 7 - (i & 7));
          i++;
        }
      }
    }
  }

  /** XORs `mask` into the data modules (applying it twice undoes it). */
  applyMask(mask: number): void {
    const test = MASKS[mask]!;
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!this.reserved[r]![c] && test(r, c)) this.modules[r]![c] = !this.modules[r]![c];
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Mask penalty (ISO/IEC 18004:2015, 7.8.3), counted as ZXing does.

/** N1: every run of 5 or more modules of one colour in a line scores 3 + (length − 5). */
export function runPenalty(line: readonly boolean[]): number {
  let score = 0;
  let run = 0;
  // One step past each end, where line[i] is undefined, so the first and last runs close too.
  for (let i = 0; i <= line.length; i++) {
    if (line[i] === line[i - 1]) {
      run++;
      continue;
    }
    if (run >= 5) score += run - 2;
    run = 1;
  }
  return score;
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

/** Light for the four modules from `from`; outside the symbol counts as light. */
const lightRun = (line: readonly boolean[], from: number): boolean =>
  [0, 1, 2, 3].every((k) => line[from + k] !== true);

/** N3: 40 for every dark-light-dark×3-light-dark with four light modules before or after it. */
export function finderPenalty(line: readonly boolean[]): number {
  let score = 0;
  // From every position; near the end the pattern runs off the line and cannot match.
  line.forEach((_, i) => {
    if (FINDER_LIKE.every((dark, k) => line[i + k] === dark) && (lightRun(line, i - 4) || lightRun(line, i + 7))) {
      score += 40;
    }
  });
  return score;
}

export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  const columns = modules.map((_, c) => modules.map((row) => row[c]!));
  let score = 0;
  for (const line of [...modules, ...columns]) score += runPenalty(line) + finderPenalty(line);
  // N2: 3 for every 2×2 block of one colour.
  for (let r = 0; r + 1 < size; r++) {
    // Stryker disable next-line EqualityOperator: past the last column modules[r][c + 1] is undefined and never matches.
    for (let c = 0; c + 1 < size; c++) {
      const v = modules[r]![c];
      if (modules[r]![c + 1] === v && modules[r + 1]![c] === v && modules[r + 1]![c + 1] === v) score += 3;
    }
  }
  // N4: 10 for every full 5% that the dark share is away from 50%.
  const dark = modules.flat().filter(Boolean).length;
  score += Math.floor((Math.abs(dark * 2 - size * size) * 10) / (size * size)) * 10;
  return score;
}

// ---------------------------------------------------------------------------------------------

/** The mask with the lowest penalty; the lowest number on a tie. */
function bestMask(symbol: Matrix): number {
  const scores = MASKS.map((_, m) => {
    symbol.applyMask(m);
    symbol.drawFormat(m);
    const score = penalty(symbol.modules);
    symbol.applyMask(m);
    return score;
  });
  return scores.indexOf(Math.min(...scores));
}

export interface QrCode {
  version: number;
  mask: number;
  /** `modules[row][column]`, `true` is dark; without the quiet zone. */
  modules: boolean[][];
}

/**
 * Encodes `text` (as UTF-8) in the smallest version that fits, with the mask of lowest penalty
 * unless `mask` is given. `null` if it does not fit in version 10.
 */
export function encodeQr(text: string, mask?: number): QrCode | null {
  const data = new TextEncoder().encode(text);
  let version = 1;
  while (byteCapacity(version) < data.length) {
    if (version === MAX_VERSION) return null;
    version++;
  }
  const symbol = new Matrix(version);
  symbol.drawCodewords(finalCodewords(dataCodewords(data, version), version));

  const chosen = mask ?? bestMask(symbol);
  symbol.applyMask(chosen);
  symbol.drawFormat(chosen);
  return { version, mask: chosen, modules: symbol.modules };
}

const HALF_BLOCKS = [" ", "▄", "▀", "█"] as const;

/**
 * Two rows per line of text with "▀", "▄" and "█" for the dark modules, inside a light quiet
 * zone of `margin` modules. The ANSI codes force black on white so the code scans the same in a
 * dark or a light terminal.
 */
export function renderHalfBlocks(modules: readonly (readonly boolean[])[], margin = 2): string {
  const size = modules.length;
  const dark = (r: number, c: number) => modules[r]?.[c] === true;
  const lines: string[] = [];
  for (let r = -margin; r < size + margin; r += 2) {
    let line = "";
    for (let c = -margin; c < size + margin; c++) line += HALF_BLOCKS[(dark(r, c) ? 2 : 0) + (dark(r + 1, c) ? 1 : 0)];
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join("\n");
}
