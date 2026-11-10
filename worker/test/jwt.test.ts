import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appleJWT, b64url, importP8, signAppleJWT } from "../src/apple/jwt";

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

describe("b64url", () => {
  // RFC 4648, sección 10, sin relleno: cubre 0, 1 y 2 caracteres "=" en base64.
  it.each([
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ])("texto %j → %j", (input, expected) => {
    expect(b64url(input)).toBe(expected);
  });

  // En base64 estándar dan "++++", "////" y "+/8=": aquí, el alfabeto URL y sin relleno.
  it.each([
    [[0xfb, 0xef, 0xbe], "----"],
    [[0xff, 0xff, 0xff], "____"],
    [[0xfb, 0xff], "-_8"],
  ])("bytes %j → %j", (bytes, expected) => {
    expect(b64url(new Uint8Array(bytes))).toBe(expected);
    expect(b64url(new Uint8Array(bytes).buffer)).toBe(expected);
  });

  it("codifica el texto como UTF-8", () => {
    expect(b64url("ñ")).toBe("w7E");
  });
});

describe("JWT ES256 para Apple", () => {
  // Sección 16, punto 1: importación pkcs8 de una clave P-256 en el runtime de Workers.
  it("importa un .p8 (PKCS#8, P-256) y firma un JWT verificable", async () => {
    const key = await importP8(env.APPLE_DC_KEY_P8_DEMO);
    const jwt = await signAppleJWT(key, "KEY0000000", "TEAM000000", 1_800_000_000);
    const [h, c, s] = jwt.split(".");

    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: "ES256", kid: "KEY0000000" });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c)))).toEqual({ iss: "TEAM000000", iat: 1_800_000_000 });

    const sig = fromB64url(s);
    expect(sig.byteLength).toBe(64); // r || s, sin DER

    const pub = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(env.TEST_PUBLIC_JWK),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      sig,
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  it("la clave privada importada no es extraíble", async () => {
    expect((await importP8(env.APPLE_DC_KEY_P8_DEMO)).extractable).toBe(false);
  });

  it("por defecto, iat es la hora actual en segundos", async () => {
    const apple = { p8: env.APPLE_DC_KEY_P8_DEMO, keyId: "KEYNOW0000", teamId: "TEAM000000" };
    const before = Math.floor(Date.now() / 1000);
    const [, claims] = (await appleJWT(apple)).split(".");
    const { iat } = JSON.parse(new TextDecoder().decode(fromB64url(claims!)));
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("la caché distingue claves: otro kid u otro equipo no reutilizan el JWT", async () => {
    const t0 = 1_950_000_000;
    const base = { p8: env.APPLE_DC_KEY_P8_DEMO, keyId: "KEYA000000", teamId: "TEAMA00000" };
    const a = await appleJWT(base, t0);
    const otherKey = await appleJWT({ ...base, keyId: "KEYB000000" }, t0);
    const otherTeam = await appleJWT({ ...base, teamId: "TEAMB00000" }, t0);
    expect(new Set([a, otherKey, otherTeam]).size).toBe(3);
  });

  it("reutiliza el JWT durante 30 minutos y luego lo regenera", async () => {
    const apple = { p8: env.APPLE_DC_KEY_P8_DEMO, keyId: "KEYCACHE00", teamId: "TEAM000000" };
    const t0 = 1_900_000_000;
    const first = await appleJWT(apple, t0);
    expect(await appleJWT(apple, t0 + 29 * 60)).toBe(first);
    expect(await appleJWT(apple, t0 + 30 * 60)).not.toBe(first);
  });
});
