// Admin device cryptography (docs/DEVICE-PAIRING.md, sections 2 and 3): base64url, the canonical
// string of a signed request, ECDSA P-256 verification and the verification code. No D1 here.
// spec/device-signature-vectors.json pins every format: the Dashboard's Swift tests read it too.

import { b64url } from "./apple/jwt";

export const SIGNATURE_VERSION = "NONGRATA-SIG-V1";
const PAIR_PROOF_PREFIX = "NONGRATA-PAIR-V1";
const VERIFY_PREFIX = "NONGRATA-VERIFY-V1";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `length` random bytes, base64url without padding. */
export const randomToken = (length: number): string => b64url(crypto.getRandomValues(new Uint8Array(length)));

/**
 * The bytes of `text` if it is canonical base64url without padding (exactly what `b64url`
 * would produce) and decodes to `length` bytes; `null` otherwise. Rejecting the other spellings
 * of the same bytes (padding, `+` and `/`, stray bits at the end) leaves one text per value.
 */
export function fromB64url(text: string, length: number): Uint8Array | null {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return bytes.length === length && b64url(bytes) === text ? bytes : null;
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc(data) : data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two hex SHA-256 digests (always 64 characters). */
export const sameDigest = (a: string, b: string): boolean => crypto.subtle.timingSafeEqual(enc(a), enc(b));

/** Tested on one character at a time. */
const UNRESERVED_RE = /[A-Za-z0-9._~-]/;

/** RFC 3986 encoding of the UTF-8 bytes: unreserved characters stay, the rest as `%XX` uppercase. */
export function encodeUnreserved(text: string): string {
  let out = "";
  for (const byte of enc(text)) {
    const c = String.fromCharCode(byte);
    out += UNRESERVED_RE.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every `name=value` pair of the query, decoded the way the Worker reads it (as
 * application/x-www-form-urlencoded, so `+` is a space), encoded again with `encodeUnreserved`,
 * sorted by encoded name and then encoded value (byte order: they are ASCII), joined with `&`.
 */
export function canonicalQuery(search: string): string {
  return [...new URLSearchParams(search)]
    .map(([name, value]) => [encodeUnreserved(name), encodeUnreserved(value)] as const)
    .sort(([an, av], [bn, bv]) => compare(an, bn) || compare(av, bv))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export interface SignedRequest {
  method: string;
  url: URL;
  timestamp: string;
  nonce: string;
  device: string;
  /** Hex SHA-256 of the raw body (of the empty string without a body). */
  bodyHash: string;
}

/** Section 3.2: the lines joined with `\n`, no trailing newline. */
export const canonicalString = (r: SignedRequest): string =>
  [
    SIGNATURE_VERSION,
    r.method.toUpperCase(),
    r.url.host.toLowerCase(),
    r.url.pathname,
    canonicalQuery(r.url.search),
    r.timestamp,
    r.nonce,
    r.device,
    r.bodyHash,
  ].join("\n");

/** What the claim's `proof` signs: it shows the claimant holds the private key. */
export const pairProofMessage = (pairingId: string, publicKey: string): string =>
  `${PAIR_PROOF_PREFIX}\n${pairingId}\n${publicKey}`;

/**
 * ECDSA P-256 with SHA-256 over the UTF-8 of `message`. `publicKey` is the 65-byte uncompressed
 * point and `signature` the raw 64-byte r || s. `false` for a point that is not on the curve.
 */
export async function verifySignature(publicKey: Uint8Array, signature: Uint8Array, message: string): Promise<boolean> {
  let key: CryptoKey;
  try {
    // Stryker disable next-line BooleanLiteral: `extractable` only matters to exportKey, which is never called.
    key = await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return false;
  }
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, enc(message));
}

/**
 * Section 2.3: the first 4 bytes of SHA-256("NONGRATA-VERIFY-V1\n" + id + "\n" + public_key),
 * big-endian, modulo 1 000 000, as 6 digits.
 */
export async function verificationCode(pairingId: string, publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc(`${VERIFY_PREFIX}\n${pairingId}\n${publicKey}`));
  return String(new DataView(digest).getUint32(0) % 1_000_000).padStart(6, "0");
}
