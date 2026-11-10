// Admin device cryptography against spec/device-signature-vectors.json (computed with openssl and
// shasum, outside this code) and the edge cases of each format.

import { describe, expect, it } from "vitest";
import vectors from "../../spec/device-signature-vectors.json";
import {
  canonicalQuery,
  canonicalString,
  encodeUnreserved,
  fromB64url,
  pairProofMessage,
  sha256Hex,
  verificationCode,
  verifySignature,
} from "../src/signature";

const key = fromB64url(vectors.key.public_key, 65)!;
const sig = (text: string) => fromB64url(text, 64)!;

describe("signed requests: golden vectors", () => {
  it.each(vectors.requests)("$name", async (v) => {
    const body = v.body ?? "";
    expect(await sha256Hex(body)).toBe(v.body_sha256);
    const canonical = canonicalString({
      method: v.method,
      url: new URL(v.url),
      timestamp: v.headers["NonGrata-Timestamp"],
      nonce: v.headers["NonGrata-Nonce"],
      device: v.headers["NonGrata-Device"],
      bodyHash: v.body_sha256,
    });
    expect(canonical).toBe(v.canonical);
    expect(await verifySignature(key, sig(v.signature), v.canonical)).toBe(true);
    // One character more and it no longer verifies.
    expect(await verifySignature(key, sig(v.signature), `${v.canonical} `)).toBe(false);
  });

  it("the method is uppercased and the host lowercased", () => {
    const v = vectors.requests[0]!;
    const parts = {
      url: new URL(v.url.replace("nongrata-myapp", "NonGrata-MyApp")),
      timestamp: v.headers["NonGrata-Timestamp"],
      nonce: v.headers["NonGrata-Nonce"],
      device: v.headers["NonGrata-Device"],
      bodyHash: v.body_sha256,
    };
    expect(canonicalString({ method: "get", ...parts })).toBe(v.canonical);
  });

  it("the claim proof and the verification codes", async () => {
    const p = vectors.pairing;
    expect(pairProofMessage(p.id, p.public_key)).toBe(p.proof_message);
    expect(await verifySignature(key, sig(p.proof), p.proof_message)).toBe(true);
    expect(await verifySignature(key, sig(p.proof), pairProofMessage(p.id, `${p.public_key}x`))).toBe(false);
    for (const c of vectors.verification_codes) {
      expect(await verificationCode(c.id, c.public_key)).toBe(c.code);
    }
  });

  it("a point that is not on the curve does not verify, and does not throw", async () => {
    const bad = new Uint8Array(65);
    bad[0] = 4;
    expect(await verifySignature(bad, sig(vectors.pairing.proof), vectors.pairing.proof_message)).toBe(false);
  });
});

describe("fromB64url", () => {
  it("decodes canonical base64url, with - and _ anywhere", () => {
    expect([...fromB64url("-_-_", 3)!]).toEqual([0xfb, 0xff, 0xbf]);
    expect([...fromB64url("AAECAwQFBgcICQoLDA0ODw", 16)!]).toEqual([...Array(16).keys()]);
    expect(fromB64url("", 0)).toEqual(new Uint8Array());
  });

  it.each([
    ["the wrong length", "AAECAwQFBgcICQoLDA0ODw", 15],
    ["padding", "AAECAwQFBgcICQoLDA0ODw==", 16],
    ["+ instead of -", "+_-_", 3],
    ["/ instead of _", "-/-_", 3],
    ["whitespace", "AAEC AwQFBgcICQoLDA0ODw", 16],
    ["stray bits at the end", "AAECAwQFBgcICQoLDA0ODx", 16],
    ["characters outside the alphabet", "AAECAwQFBgcICQoLDA0OD!", 16],
    ["an impossible length", "A", 0],
  ])("rejects %s", (_name, text, length) => {
    expect(fromB64url(text, length)).toBeNull();
  });
});

describe("canonical query", () => {
  it("keeps the RFC 3986 unreserved characters and encodes the rest as uppercase %XX of UTF-8", () => {
    expect(encodeUnreserved("AZaz09-._~")).toBe("AZaz09-._~");
    expect(encodeUnreserved(" !*'()+/:=&\n")).toBe("%20%21%2A%27%28%29%2B%2F%3A%3D%26%0A");
    expect(encodeUnreserved("ñ✓")).toBe("%C3%B1%E2%9C%93");
  });

  it.each([
    ["", ""],
    ["?", ""],
    ["?b=2&a=1", "a=1&b=2"],
    // By name first, then by value: "a" < "a-b" although "a=" > "a-b=".
    ["?a-b=1&a=2", "a=2&a-b=1"],
    ["?k=b&k=a&k=a", "k=a&k=a&k=b"],
    ["?k=a&k=b", "k=a&k=b"],
    ["?k=b&k=a", "k=a&k=b"],
    ["?b=1&a=2&b=0&a=1", "a=1&a=2&b=0&b=1"],
    // As the Worker reads it: "+" is a space, "%2B" a plus, and a bare name has an empty value.
    ["?q=a+b&p=a%2Bb&flag", "flag=&p=a%2Bb&q=a%20b"],
    ["?%7e=%41", "~=A"],
  ])("%j → %j", (search, expected) => {
    expect(canonicalQuery(search)).toBe(expected);
  });
});
