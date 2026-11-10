// The QR encoder of `nongrata pair` against outside references: matrices drawn by Apple's
// CoreImage (fixtures/qr-reference.json, see qr-reference.swift), the worked example of
// ISO/IEC 18004 for Reed-Solomon, the standard's format and version information tables, and a
// decoder written here, apart from the encoder, for round trips.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import reference from "./fixtures/qr-reference.json" with { type: "json" };
import {
  byteCapacity,
  dataCodewords,
  encodeQr,
  finderPenalty,
  formatBits,
  MAX_VERSION,
  penalty,
  renderHalfBlocks,
  rsRemainder,
  runPenalty,
  versionBits,
} from "../src/qr.ts";

type Modules = boolean[][];

const parse = (rows: string[]): Modules => rows.map((r) => [...r].map((c) => c === "1"));
const show = (m: Modules): string[] => m.map((r) => r.map((b) => (b ? "1" : "0")).join(""));
const bits = (text: string): boolean[] => [...text].map((c) => c === "1");

// ---------------------------------------------------------------------------------------------
// An independent decoder: tables copied from ISO/IEC 18004:2015, code written for the tests.

/** Format information for level M, masks 0 to 7 (ISO/IEC 18004, table C.1). */
const FORMAT_M = [
  "101010000010010",
  "101000100100101",
  "101111001111100",
  "101101101001011",
  "100010111111001",
  "100000011001110",
  "100111110010111",
  "100101010100000",
];

/** Version information, versions 7 to 10 (table D.1). */
const VERSION_INFO: Record<number, string> = {
  7: "000111110010010100",
  8: "001000010110111100",
  9: "001001101010011001",
  10: "001010010011010011",
};

/** Level M: EC codewords per block and [blocks, data codewords] (table 9). */
const EC_M: [number, [number, number][]][] = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

const ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Which modules are not data: finders with separators and format areas, timing, alignment, version. */
function functionMap(version: number): Modules {
  const size = version * 4 + 17;
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) map[r]![c] = true;
  };
  mark(0, 0, 9, 9);
  mark(0, size - 8, 9, 8);
  mark(size - 8, 0, 8, 9);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  // Every pair of centres except the three in a finder's corner.
  const centres = ALIGNMENT[version - 1]!;
  const corner = (r: number, c: number) => (r < 9 || r >= size - 8) && (c < 9 || c >= size - 8) && !(r >= size - 8 && c >= size - 8);
  for (const r of centres) for (const c of centres) if (!corner(r, c)) mark(r - 2, c - 2, 5, 5);
  if (version >= 7) {
    mark(0, size - 11, 6, 3);
    mark(size - 11, 0, 3, 6);
  }
  return map;
}

const MASK_TESTS = [
  (r: number, c: number) => (r + c) % 2 === 0,
  (r: number) => r % 2 === 0,
  (_: number, c: number) => c % 3 === 0,
  (r: number, c: number) => (r + c) % 3 === 0,
  (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const EXP: number[] = [];
for (let i = 0, x = 1; i < 255; i++, x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : x << 1) EXP.push(x);
const LOG = new Array<number>(256);
EXP.forEach((x, i) => (LOG[x] = i));
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a]! + LOG[b]!) % 255]!);

/** A Reed-Solomon codeword with `ec` check symbols is zero at α^0 … α^(ec−1). */
function syndromesAreZero(block: number[], ec: number): boolean {
  for (let i = 0; i < ec; i++) {
    let value = 0;
    for (const c of block) value = mul(value, EXP[i]!) ^ c;
    if (value !== 0) return false;
  }
  return true;
}

function decode(modules: Modules): { version: number; mask: number; text: string } {
  const size = modules.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `size ${size}`);
  const at = (r: number, c: number) => (modules[r]![c] ? "1" : "0");

  // Both copies of the format information, bit 14 first.
  let first = "";
  for (const c of [0, 1, 2, 3, 4, 5, 7, 8]) first += at(8, c);
  for (const r of [7, 5, 4, 3, 2, 1, 0]) first += at(r, 8);
  let second = "";
  for (let r = size - 1; r >= size - 7; r--) second += at(r, 8);
  for (let c = size - 8; c < size; c++) second += at(8, c);
  assert.equal(first, second, "the two copies of the format information");
  const mask = FORMAT_M.indexOf(first);
  assert.ok(mask >= 0, `format information ${first} is not level M`);
  assert.equal(at(size - 8, 8), "1", "the dark module");

  if (version >= 7) {
    let topRight = "";
    let bottomLeft = "";
    for (let i = 17; i >= 0; i--) {
      topRight += at(Math.floor(i / 3), size - 11 + (i % 3));
      bottomLeft += at(size - 11 + (i % 3), Math.floor(i / 3));
    }
    assert.equal(topRight, VERSION_INFO[version]);
    assert.equal(bottomLeft, VERSION_INFO[version]);
  }

  const map = functionMap(version);
  const stream: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (map[r]![c]) continue;
        stream.push(Number(modules[r]![c] !== MASK_TESTS[mask]!(r, c)));
      }
    }
  }

  const [ec, groups] = EC_M[version - 1]!;
  const sizes = groups.flatMap(([count, n]) => new Array<number>(count).fill(n));
  const total = sizes.reduce((a, b) => a + b, 0) + ec * sizes.length;
  const words: number[] = [];
  for (let i = 0; i < total * 8; i += 8) words.push(parseInt(stream.slice(i, i + 8).join(""), 2));
  assert.ok(stream.slice(total * 8).every((b) => b === 0), "remainder bits are 0");

  // De-interleave, check each block, and join the data.
  const blocks = sizes.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++) blocks.forEach((b, j) => i < sizes[j]! && b.push(words[k++]!));
  for (let i = 0; i < ec; i++) for (const b of blocks) b.push(words[k++]!);
  blocks.forEach((b) => assert.ok(syndromesAreZero(b, ec), "Reed-Solomon syndromes"));
  const data = blocks.flatMap((b, j) => b.slice(0, sizes[j]));

  const dataBits = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >> i) & 1));
  const read = (from: number, n: number) => parseInt(dataBits.slice(from, from + n).join(""), 2);
  assert.equal(read(0, 4), 0b0100, "byte mode");
  const countLength = version < 10 ? 8 : 16;
  const count = read(4, countLength);
  const bytes = Array.from({ length: count }, (_, i) => read(4 + countLength + i * 8, 8));
  const end = 4 + countLength + count * 8;
  assert.equal(read(end, 4), 0, "terminator");
  const pads = data.slice((end + 4) / 8);
  pads.forEach((p, i) => assert.equal(p, i % 2 === 0 ? 0xec : 0x11, "padding"));
  return { version, mask, text: new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)) };
}

// ---------------------------------------------------------------------------------------------

describe("QR: CoreImage reference matrices", () => {
  for (const v of reference.vectors) {
    it(`v${v.version}, ${new TextEncoder().encode(v.text).length} bytes`, () => {
      const expected = parse(v.modules);
      // CoreImage picks its own mask; with the same one, the matrix is identical.
      const { mask } = decode(expected);
      const qr = encodeQr(v.text, mask)!;
      assert.equal(qr.version, v.version);
      assert.equal(qr.mask, mask);
      assert.deepEqual(show(qr.modules), v.modules);
    });
  }

  it("covers versions 1 to 10", () => {
    assert.deepEqual([...new Set(reference.vectors.map((v) => v.version))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("QR: round trips through the decoder", () => {
  const texts = [
    "",
    "a",
    "ñandú ✓ 🙂",
    ...[14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 200, 213].map((n) =>
      Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7) % 94))).join(""),
    ),
  ];
  for (const text of texts) {
    it(`${new TextEncoder().encode(text).length} bytes, every mask`, () => {
      for (let mask = 0; mask < 8; mask++) {
        const qr = encodeQr(text, mask)!;
        assert.deepEqual(decode(qr.modules), { version: qr.version, mask, text });
      }
      const auto = encodeQr(text)!;
      assert.equal(decode(auto.modules).text, text);
    });
  }

  it("the smallest version that fits; nothing past version 10", () => {
    const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    assert.deepEqual([...Array(MAX_VERSION).keys()].map((i) => byteCapacity(i + 1)), capacities);
    capacities.forEach((n, i) => {
      assert.equal(encodeQr("x".repeat(n))!.version, i + 1);
      if (i + 1 < MAX_VERSION) assert.equal(encodeQr("x".repeat(n + 1))!.version, i + 2);
    });
    assert.equal(encodeQr("x".repeat(214)), null);
    assert.equal(encodeQr("é".repeat(107)), null, "counted in UTF-8 bytes");
  });

  it("the automatic mask is the first one with the lowest penalty", () => {
    for (const v of reference.vectors) {
      const scores = [...Array(8).keys()].map((m) => penalty(encodeQr(v.text, m)!.modules));
      assert.equal(encodeQr(v.text)!.mask, scores.indexOf(Math.min(...scores)), v.text);
    }
  });
});

describe("QR: codewords", () => {
  // ISO/IEC 18004:2015, annex I: "01234567" as 1-M. Numeric mode, but the Reed-Solomon step is
  // the same for every mode.
  it("Reed-Solomon: the standard's worked example", () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    assert.deepEqual(rsRemainder(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  it("Reed-Solomon: every block of every version passes the syndrome check", () => {
    for (const [ec] of EC_M) {
      const data = Array.from({ length: 40 }, (_, i) => (i * 37 + ec) & 0xff);
      assert.ok(syndromesAreZero([...data, ...rsRemainder(data, ec)], ec), `ec ${ec}`);
    }
  });

  it('byte mode, count, data, terminator and padding: "hello" in 1-M', () => {
    assert.deepEqual(
      dataCodewords(new TextEncoder().encode("hello"), 1),
      [0x40, 0x56, 0x86, 0x56, 0xc6, 0xc6, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec],
    );
    assert.deepEqual(dataCodewords(new Uint8Array(), 1), [0x40, 0x00, ...Array(7).fill([0xec, 0x11]).flat()]);
    // From version 10 the count has 16 bits.
    assert.deepEqual(dataCodewords(new Uint8Array([0xff]), 10).slice(0, 4), [0x40, 0x00, 0x1f, 0xf0]);
  });

  it("format and version information match the standard's tables", () => {
    FORMAT_M.forEach((expected, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, "0"), expected));
    for (const [version, expected] of Object.entries(VERSION_INFO)) {
      assert.equal(versionBits(Number(version)).toString(2).padStart(18, "0"), expected);
    }
  });
});

describe("QR: mask penalty", () => {
  it("N1: 3 for a run of 5, plus 1 for each module more, first and last runs too", () => {
    assert.equal(runPenalty(bits("0000")), 0);
    assert.equal(runPenalty(bits("00000")), 3);
    assert.equal(runPenalty(bits("000000")), 4);
    assert.equal(runPenalty(bits("1111111")), 5);
    assert.equal(runPenalty(bits("11111000000")), 3 + 4);
    assert.equal(runPenalty(bits("011111")), 3);
    assert.equal(runPenalty(bits("0101010101")), 0);
    assert.equal(runPenalty([]), 0);
  });

  it("N3: 40 for each 1011101 with four light modules on either side, outside counting as light", () => {
    assert.equal(finderPenalty(bits("1011101")), 40);
    assert.equal(finderPenalty(bits("101110")), 0);
    assert.equal(finderPenalty(bits("00001011101")), 40, "light on both sides counts once");
    assert.equal(finderPenalty(bits("10111010001")), 40, "light before (outside)");
    assert.equal(finderPenalty(bits("110111010001")), 0, "dark within four on both sides");
    assert.equal(finderPenalty(bits("110111010000")), 40, "four light after");
    assert.equal(finderPenalty(bits("000110111011")), 0, "only three light before");
    assert.equal(finderPenalty(bits("101110100001011101")), 80, "two of them");
    assert.equal(finderPenalty(bits("1011001")), 0);
    assert.equal(finderPenalty(bits("1001101")), 0);
  });

  it("N2 and N4, and the sum over rows and columns", () => {
    const light5 = Array.from({ length: 5 }, () => bits("00000"));
    // N1: 10 runs of 5 (3 each); N2: 16 blocks (3 each); N4: 50% away, 10 steps of 5% (10 each).
    assert.equal(penalty(light5), 30 + 48 + 100);
    assert.equal(penalty([bits("10"), bits("01")]), 0);
    assert.equal(penalty([bits("11"), bits("11")]), 3 + 100);
    // 4 dark of 9: 44%, one full step of 5% away. 7 of 9: 77%, five steps.
    assert.equal(penalty([bits("101"), bits("010"), bits("001")]), 10);
    assert.equal(penalty([bits("111"), bits("101"), bits("110")]), 50);
    // 5 of 9 dark: 55%, one step; one dark 2×2 block in the top left.
    assert.equal(penalty([bits("110"), bits("110"), bits("001")]), 10 + 3);
    // A finder pattern alone: N1 2·(5+3+3+5), N3 2·3·40, N2 the 4 blocks of its centre, N4 33 of 49.
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"].map(bits);
    assert.equal(penalty(finder), 32 + 240 + 12 + 30);
  });
});

describe("QR: half blocks", () => {
  it("two rows per line, every glyph, inside the quiet zone, black on white", () => {
    const m = [bits("101"), bits("110"), bits("010")];
    const wrap = (line: string) => `\x1b[30;47m${line}\x1b[0m`;
    assert.equal(renderHalfBlocks(m, 1), [" ▄ ▄ ", " ▀█  ", "     "].map(wrap).join("\n"));
  });

  it("an even number of rows: the last line is not doubled", () => {
    const wrap = (line: string) => `\x1b[30;47m${line}\x1b[0m`;
    assert.equal(renderHalfBlocks([bits("10"), bits("01")], 1), [" ▄  ", "  ▀ "].map(wrap).join("\n"));
  });

  it("a quiet zone of 2 modules by default", () => {
    const lines = renderHalfBlocks([[true]]).split("\n");
    assert.deepEqual(lines, ["     ", "  ▀  ", "     "].map((l) => `\x1b[30;47m${l}\x1b[0m`));
  });
});
