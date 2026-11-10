// Fórmula compartida con el SDK Swift y la CLI: SHA256(prefix + ":" + kind + ":" + valor
// normalizado). Los vectores de spec/hash-vectors.json fijan el resultado: si cambias algo aquí,
// cambian todas las listas existentes.

export const KINDS = ["idfv", "install", "icloud", "user", "android_id"] as const;
export type Kind = (typeof KINDS)[number];

export const isKind = (value: unknown): value is Kind =>
  typeof value === "string" && (KINDS as readonly string[]).includes(value);

const HASH_RE = /^[0-9a-f]{64}$/;
const REF_RE = /^[0-9A-F]{8}$/;

export const isHash = (value: unknown): value is string =>
  typeof value === "string" && HASH_RE.test(value);

export const isRef = (value: unknown): value is string =>
  typeof value === "string" && REF_RE.test(value);

// Normalización previa al hash, idéntica en el SDK: quita espacios, tabuladores y saltos de línea
// ASCII de los extremos, y pasa a mayúsculas (solo a-z) los UUID, que iOS da en mayúsculas.
// `icloud`, `user` y `android_id` son opacos y conservan las mayúsculas y minúsculas.
const EDGE_WHITESPACE_RE = /^[ \t\n\r]+|[ \t\n\r]+$/g;
const UUID_KINDS: readonly Kind[] = ["idfv", "install"];

export function normalizeValue(kind: Kind, value: string): string {
  const trimmed = value.replace(EDGE_WHITESPACE_RE, "");
  return UUID_KINDS.includes(kind) ? trimmed.replace(/[a-z]/g, (c) => c.toUpperCase()) : trimmed;
}

export async function hashId(prefix: string, kind: Kind, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${prefix}:${kind}:${normalizeValue(kind, value)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Código de soporte: primeros 8 caracteres, en mayúsculas, del hash de `installId`. */
export const refFromInstallHash = (installHash: string): string =>
  installHash.slice(0, 8).toUpperCase();
