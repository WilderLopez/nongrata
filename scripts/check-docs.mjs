#!/usr/bin/env node
/**
 * Checks the documentation and what gets published:
 * - Relative Markdown links in docs/ and in the root Markdown files lead to a file that exists
 *   and do not leave the repo. No [[wikilinks]], which GitHub does not understand.
 * - Language parity: English docs (README.md and every .md under docs/ outside docs/es/) and
 *   their Spanish copies (README.es.md and docs/es/) link to each other. Each English doc links
 *   to a Spanish doc that links back to it, and each Spanish doc links to an English doc that
 *   links back to it. README.md pairs with README.es.md; docs/ pairs with docs/es/. Skipped
 *   while docs/es/ does not exist.
 * - With a `.public-terms` file at the root (local, ignored by git): no file in the repo contains
 *   those terms, for example the names of private apps or account IDs.
 *
 * Usage: node scripts/check-docs.mjs   (exit code 1 if anything is off)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPANISH_DIR = "docs/es/";
const errors = [];
const notes = [];

// Tracked files plus new ones not added yet, minus those git ignores.
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && existsSync(join(ROOT, f)));

const docs = files.filter((f) => f.endsWith(".md") && (f.startsWith("docs/") || !f.includes("/")));

/** Repo-relative paths (with "/") of the existing files each doc links to. */
const linksOf = new Map();

for (const f of docs) {
  const path = join(ROOT, f);
  // Drop code blocks and inline code: a "[x](y)" there is text, not a link.
  const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const targets = new Set();
  // Markdown links, plus href/src of the HTML that READMEs use for centred headers and images.
  const found = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/\b(?:href|src)="([^"]+)"/g)];
  for (const [, link] of found) {
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const target = resolve(dirname(path), decodeURIComponent(link.split("#")[0]));
    const rel = relative(ROOT, target);
    if (rel.startsWith("..")) errors.push(`${f}: the link ${link} leaves the repo`);
    else if (!existsSync(target)) errors.push(`${f}: broken link to ${link}`);
    else targets.add(rel.split(sep).join("/"));
  }
  linksOf.set(f, targets);
  if (/\[\[[^\]]+\]\]/.test(text)) errors.push(`${f}: uses [[wikilinks]]; use relative Markdown links`);
}

// Language parity. Each doc's possible counterparts are the docs of the other language on its
// side: README.md <-> README.es.md, docs/ <-> docs/es/.
const isSpanishDoc = (f) => f.startsWith(SPANISH_DIR);
const isEnglishDoc = (f) => f.startsWith("docs/") && !isSpanishDoc(f);
const parity = [
  ...docs.filter((f) => f === "README.md").map((f) => [f, "English", "README.es.md", (t) => t === "README.es.md"]),
  ...docs.filter(isEnglishDoc).map((f) => [f, "English", `a Spanish doc under ${SPANISH_DIR}`, isSpanishDoc]),
  ...docs.filter((f) => f === "README.es.md").map((f) => [f, "Spanish", "README.md", (t) => t === "README.md"]),
  ...docs.filter(isSpanishDoc).map((f) => [f, "Spanish", `an English doc outside ${SPANISH_DIR}`, isEnglishDoc]),
];
if (!existsSync(join(ROOT, SPANISH_DIR))) {
  notes.push(`no ${SPANISH_DIR} yet: language parity not checked.`);
} else {
  for (const [f, language, expected, isCounterpart] of parity) {
    const candidates = [...linksOf.get(f)].filter((t) => docs.includes(t) && isCounterpart(t));
    const other = language === "English" ? "Spanish" : "English";
    if (candidates.length === 0) {
      errors.push(`${f}: no link to its ${other} version (${expected})`);
    } else if (!candidates.some((t) => linksOf.get(t).has(f))) {
      const which = candidates.length === 1 ? "it does not link" : "none of them links";
      errors.push(`${f}: links to ${candidates.join(", ")} as its ${other} version, but ${which} back`);
    }
  }
}

const termsFile = join(ROOT, ".public-terms");
let terms = [];
if (existsSync(termsFile)) {
  terms = readFileSync(termsFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.toLowerCase());
  for (const f of files) {
    const content = readFileSync(join(ROOT, f));
    if (content.includes(0)) continue; // binary
    const lines = content.toString("utf8").toLowerCase().split("\n");
    for (const t of terms) {
      if (f.toLowerCase().includes(t)) errors.push(`${f}: the file name contains a private term`);
      lines.forEach((l, i) => {
        if (l.includes(t)) errors.push(`${f}:${i + 1}: contains a private term`);
      });
    }
  }
}

for (const n of notes) console.log(`Note: ${n}`);
if (errors.length) {
  console.error(`The documentation does not add up (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
const checked = [
  "no broken links",
  ...(notes.length ? [] : [`${parity.length} docs paired with their other-language version`]),
  terms.length
    ? `${terms.length} private terms absent from ${files.length} files`
    : "no .public-terms, so no search for private terms",
];
console.log(`Documentation is consistent: ${checked.join("; ")}.`);
