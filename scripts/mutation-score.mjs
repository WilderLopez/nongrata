#!/usr/bin/env node
/**
 * Compara el informe JSON de Stryker de un paquete (`<paquete>/reports/mutation/mutation.json`)
 * con su baseline versionado (`<paquete>/mutation-baseline.json`).
 *
 * Sale con código 1 si el score global baja más de TOLERANCIA puntos. No hay umbral absoluto:
 * un mínimo fijo invita a escribir asserts de relleno; lo que importa es no retroceder.
 *
 * Uso:
 *   node scripts/mutation-score.mjs worker            # compara con el baseline
 *   node scripts/mutation-score.mjs worker --update   # reescribe el baseline con lo medido
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = ["worker", "cli"];
const TOLERANCIA = 1.0; // puntos porcentuales de margen para el ruido de timeouts

const HELP = `Uso: node scripts/mutation-score.mjs <${PACKAGES.join("|")}> [--update]

Compara <paquete>/reports/mutation/mutation.json (la salida de "pnpm --dir <paquete>
test:mutation") con <paquete>/mutation-baseline.json y falla (código 1) si el score global bajó
más de ${TOLERANCIA} punto.

  --update      reescribe el baseline con lo medido en la corrida actual
  --help, -h    muestra esta ayuda`;

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

/** Killed y Timeout cuentan como detectados; los errores de compilación no cuentan. */
function scoreOf(mutants) {
  const n = (status) => mutants.filter((m) => m.status === status).length;
  const detectados = n("Killed") + n("Timeout");
  const total = detectados + n("Survived") + n("NoCoverage");
  return {
    score: total === 0 ? 100 : (detectados * 100) / total,
    survived: n("Survived"),
    noCoverage: n("NoCoverage"),
  };
}

if (!existsSync(REPORT)) {
  console.error(`No encuentro ${REPORT}. ¿Has corrido "pnpm --dir ${pkg} test:mutation"?`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const files = Object.entries(report.files ?? {}).map(([ruta, datos]) => [ruta, datos.mutants ?? []]);
const global = scoreOf(files.flatMap(([, mutants]) => mutants));

const medido = {
  global: Number(global.score.toFixed(2)),
  supervivientes: global.survived,
  sinCobertura: global.noCoverage,
  ficheros: Object.fromEntries(
    files
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ruta, mutants]) => [ruta, Number(scoreOf(mutants).score.toFixed(2))]),
  ),
};

if (args.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify(medido, null, 2)}\n`);
  console.log(`${pkg}: baseline actualizado, ${medido.global}% global.`);
  process.exit(0);
}

console.log(
  `${pkg}: score global ${medido.global}%  (${medido.supervivientes} supervivientes, ` +
    `${medido.sinCobertura} sin cobertura)`,
);

if (!existsSync(BASELINE)) {
  console.log(`No hay baseline todavía. Créalo con: node scripts/mutation-score.mjs ${pkg} --update`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const diff = medido.global - base.global;
console.log(`${pkg}: baseline     ${base.global}%  (diferencia: ${diff >= 0 ? "+" : ""}${diff.toFixed(2)})`);

const bajadas = Object.entries(medido.ficheros)
  .map(([ruta, score]) => [ruta, score, base.ficheros?.[ruta]])
  .filter(([, score, anterior]) => anterior !== undefined && score < anterior - TOLERANCIA);
if (bajadas.length > 0) {
  console.log("\nFicheros que han bajado:");
  for (const [ruta, score, anterior] of bajadas) console.log(`  ${ruta}: ${anterior}% → ${score}%`);
}

if (diff < -TOLERANCIA) {
  console.error(
    `\n${pkg}: el score global ha bajado ${Math.abs(diff).toFixed(2)} puntos. Hay tests que ` +
      `verifican menos que antes: mira ${pkg}/reports/mutation/index.html y añade los asserts que faltan.`,
  );
  process.exit(1);
}

console.log(`${pkg}: sin retrocesos.`);
