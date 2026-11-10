#!/usr/bin/env node
/**
 * Comprueba la documentación y lo que se publica:
 * - Enlaces Markdown relativos de docs/ y del README: llevan a un fichero que existe y no salen
 *   del repo. Sin [[wikilinks]], que GitHub no entiende.
 * - Con un fichero `.public-terms` en la raíz (local, git lo ignora): ningún fichero del repo
 *   contiene esos términos, por ejemplo nombres de apps propias o IDs de una cuenta.
 *
 * Uso: node scripts/check-docs.mjs   (código 1 si algo no cuadra)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errores = [];

// Ficheros versionados y los nuevos aún sin añadir, sin los que ignora git.
const ficheros = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && existsSync(join(ROOT, f)));

for (const f of ficheros.filter((f) => f.endsWith(".md") && (f.startsWith("docs/") || !f.includes("/")))) {
  const ruta = join(ROOT, f);
  // Fuera bloques de código y código en línea: ahí un "[x](y)" es texto, no un enlace.
  const texto = readFileSync(ruta, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const [, destino] of texto.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(destino)) continue;
    const objetivo = resolve(dirname(ruta), decodeURIComponent(destino.split("#")[0]));
    if (relative(ROOT, objetivo).startsWith("..")) errores.push(`${f}: el enlace ${destino} sale del repo`);
    else if (!existsSync(objetivo)) errores.push(`${f}: enlace roto a ${destino}`);
  }
  if (/\[\[[^\]]+\]\]/.test(texto)) errores.push(`${f}: usa [[wikilinks]]; usa enlaces Markdown relativos`);
}

const terminosFichero = join(ROOT, ".public-terms");
let terminos = [];
if (existsSync(terminosFichero)) {
  terminos = readFileSync(terminosFichero, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.toLowerCase());
  for (const f of ficheros) {
    const contenido = readFileSync(join(ROOT, f));
    if (contenido.includes(0)) continue; // binario
    const lineas = contenido.toString("utf8").toLowerCase().split("\n");
    for (const t of terminos) {
      if (f.toLowerCase().includes(t)) errores.push(`${f}: el nombre del fichero contiene un término privado`);
      lineas.forEach((l, i) => {
        if (l.includes(t)) errores.push(`${f}:${i + 1}: contiene un término privado`);
      });
    }
  }
}

if (errores.length) {
  console.error(`La documentación no cuadra (${errores.length}):\n${errores.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
console.log(
  terminos.length
    ? `Documentación coherente: enlaces sin romper y ${terminos.length} términos privados ausentes en ${ficheros.length} ficheros.`
    : "Documentación coherente: enlaces sin romper (sin .public-terms, no se buscan términos privados).",
);
