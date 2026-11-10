import { describe, expect, it } from "vitest";
import vectors from "../../spec/hash-vectors.json";
import { hashId, isHash, isKind, isRef, refFromInstallHash } from "../src/hash";

describe("hashId", () => {
  it.each(vectors.vectors)("$prefix:$kind:$value", async (v) => {
    if (!isKind(v.kind)) throw new Error(`kind desconocido en los vectores: ${v.kind}`);
    const hash = await hashId(v.prefix, v.kind, v.value);
    expect(hash).toBe(v.hash);
    expect(refFromInstallHash(hash)).toBe(v.ref);
  });

  it("distingue tipos con el mismo valor", async () => {
    const a = await hashId("p", "idfv", "X");
    const b = await hashId("p", "install", "X");
    expect(a).not.toBe(b);
  });
});

describe("validación de hash y ref", () => {
  const hash = "a".repeat(64);

  it("hash: 64 caracteres hex en minúsculas, ni uno más ni uno menos", () => {
    expect(isHash(hash)).toBe(true);
    for (const bad of [hash.toUpperCase(), `${hash}0`, `x${hash}`, `${hash}\n`, hash.slice(1), [hash], 1]) {
      expect(isHash(bad)).toBe(false);
    }
  });

  it("ref: 8 caracteres hex en mayúsculas, ni uno más ni uno menos", () => {
    expect(isRef("A1B2C3D4")).toBe(true);
    for (const bad of ["a1b2c3d4", "A1B2C3D4E", "XA1B2C3D4", "A1B2C3D", "A1B2C3DG", ["A1B2C3D4"], 12345678]) {
      expect(isRef(bad)).toBe(false);
    }
  });

  it("kind: solo los tipos del contrato", () => {
    for (const kind of ["idfv", "install", "icloud", "user", "android_id"]) expect(isKind(kind)).toBe(true);
    for (const bad of ["ip", "IDFV", "", ["idfv"], null]) expect(isKind(bad)).toBe(false);
  });
});
