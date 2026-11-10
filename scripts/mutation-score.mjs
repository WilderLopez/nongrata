#!/usr/bin/env node
/**
 * Compares a package's Stryker JSON report (`<package>/reports/mutation/mutation.json`) with its
 * versioned baseline (`<package>/mutation-baseline.json`).
 *
 * Exits with code 1 if the global score drops by more than TOLERANCE points. There is no absolute
 * threshold: a fixed minimum invites filler asserts; what matters is not going backwards.
 *
 * Usage:
 *   node scripts/mutation-score.mjs worker            # compare with the baseline
 *   node scripts/mutation-score.mjs worker --update   # rewrite the baseline with the measurement
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["worker", "cli"];
const TOLERANCE = 1.0; // percentage points of slack for timeout noise

const HELP = `Usage: node scripts/mutation-score.mjs <${PACKAGES.join("|")}> [--update]

Compares <package>/reports/mutation/mutation.json (the output of "pnpm --dir <package>
test:mutation") with <package>/mutation-baseline.json and fails (exit code 1) if the global score
dropped by more than ${TOLERANCE} point.

  --update      rewrite the baseline with the current run's measurement
  --help, -h    show this help`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const pkg = args.find((a) => !a.startsWith("-"));
if (!PACKAGES.includes(pkg)) {
  console.error(HELP);
  process.exit(2);
}

const REPORT = join(pkg, "reports/mutation/mutation.json");
const BASELINE = join(pkg, "mutation-baseline.json");

/** Killed and Timeout count as detected; compile errors do not count. */
function scoreOf(mutants) {
  const n = (status) => mutants.filter((m) => m.status === status).length;
  const detected = n("Killed") + n("Timeout");
  const total = detected + n("Survived") + n("NoCoverage");
  return {
    score: total === 0 ? 100 : (detected * 100) / total,
    survived: n("Survived"),
    noCoverage: n("NoCoverage"),
  };
}

if (!existsSync(REPORT)) {
  console.error(`${REPORT} not found. Did you run "pnpm --dir ${pkg} test:mutation"?`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const files = Object.entries(report.files ?? {}).map(([path, data]) => [path, data.mutants ?? []]);
const global = scoreOf(files.flatMap(([, mutants]) => mutants));

const measured = {
  global: Number(global.score.toFixed(2)),
  survived: global.survived,
  noCoverage: global.noCoverage,
  files: Object.fromEntries(
    files
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, mutants]) => [path, Number(scoreOf(mutants).score.toFixed(2))]),
  ),
};

if (args.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(`${pkg}: baseline updated, ${measured.global}% global.`);
  process.exit(0);
}

console.log(
  `${pkg}: global score ${measured.global}%  (${measured.survived} survived, ` +
    `${measured.noCoverage} without coverage)`,
);

if (!existsSync(BASELINE)) {
  console.log(`No baseline yet. Create it with: node scripts/mutation-score.mjs ${pkg} --update`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const diff = measured.global - base.global;
console.log(`${pkg}: baseline     ${base.global}%  (difference: ${diff >= 0 ? "+" : ""}${diff.toFixed(2)})`);

const drops = Object.entries(measured.files)
  .map(([path, score]) => [path, score, base.files?.[path]])
  .filter(([, score, previous]) => previous !== undefined && score < previous - TOLERANCE);
if (drops.length > 0) {
  console.log("\nFiles that dropped:");
  for (const [path, score, previous] of drops) console.log(`  ${path}: ${previous}% → ${score}%`);
}

if (diff < -TOLERANCE) {
  console.error(
    `\n${pkg}: the global score dropped by ${Math.abs(diff).toFixed(2)} points. Some tests ` +
      `verify less than before: look at ${pkg}/reports/mutation/index.html and add the missing asserts.`,
  );
  process.exit(1);
}

console.log(`${pkg}: no regressions.`);
