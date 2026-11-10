// Formula shared with the Swift SDK and the CLI: SHA256(prefix + ":" + kind + ":" + normalized
// value). The vectors in spec/hash-vectors.json pin the result: if you change anything here,
// every existing list changes.

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

// Normalization before hashing, identical in the SDK: strips ASCII spaces, tabs and line breaks
// from both ends, and uppercases (a-z only) the UUIDs, which iOS returns in uppercase.
// `icloud`, `user` and `android_id` are opaque and keep their case.
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

/** Support code: the first 8 characters, uppercased, of the `installId` hash. */
export const refFromInstallHash = (installHash: string): string =>
  installHash.slice(0, 8).toUpperCase();
