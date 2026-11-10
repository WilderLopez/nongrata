import { describe, expect, it } from "vitest";
import { appConfig, isAppId, type GuardEnv } from "../src/env";

const envOf = (vars: Record<string, unknown>) => ({ DB: null, ...vars }) as unknown as GuardEnv;

describe("isAppId", () => {
  it.each(["demo", "myapp", "a", "0app", "my-app_2", "a".repeat(32)])("acepta %j", (app) => {
    expect(isAppId(app)).toBe(true);
  });

  it.each([
    ["vacío", ""],
    ["mayúsculas", "Demo"],
    ["empieza por guion", "-app"],
    ["empieza por guion bajo", "_app"],
    ["33 caracteres", "a".repeat(33)],
    ["carácter inválido delante", "!myapp"],
    ["carácter inválido detrás", "myapp!"],
    ["ruta", "myapp/../x"],
    ["espacio", "ki st"],
    ["no es string aunque se convierta en uno válido", ["demo"]],
    ["número", 42],
    ["null", null],
  ])("rechaza %s", (_name, app) => {
    expect(isAppId(app)).toBe(false);
  });
});

describe("appConfig", () => {
  it("sin HASH_PREFIX_<APP>: null (la app responde 404)", () => {
    expect(appConfig(envOf({ HASH_PREFIX_OTRA: "p" }), "myapp")).toBeNull();
  });

  it.each([
    ["vacío", ""],
    ["no es string", 1],
    // En wrangler.jsonc, `vars` admite JSON: un array tiene `length` y no debe colar.
    ["array JSON", ["myapp-ban-v1"]],
  ])("HASH_PREFIX_<APP> %s cuenta como ausente", (_name, value) => {
    expect(appConfig(envOf({ HASH_PREFIX_MYAPP: value }), "myapp")).toBeNull();
  });

  it("el sufijo es la app en mayúsculas con los guiones como guion bajo", () => {
    const env = envOf({ HASH_PREFIX_MY_APP: "my-ban-v1", HASH_PREFIX_MYAPP: "otro" });
    expect(appConfig(env, "my-app")?.hashPrefix).toBe("my-ban-v1");
  });

  it("solo lee las variables de su app", () => {
    const env = envOf({
      HASH_PREFIX_MYAPP: "myapp-ban-v1",
      ENFORCE_OTHER: "true",
      APPLE_TEAM_ID_OTHER: "T",
      APPLE_KEY_ID_OTHER: "K",
      APPLE_DC_KEY_P8_OTHER: "P",
    });
    expect(appConfig(env, "myapp")).toEqual({ app: "myapp", hashPrefix: "myapp-ban-v1", enforce: false, apple: undefined });
  });

  it("con las tres variables de Apple, cada una en su campo", () => {
    const env = envOf({
      HASH_PREFIX_MYAPP: "myapp-ban-v1",
      APPLE_TEAM_ID_MYAPP: "TEAM",
      APPLE_KEY_ID_MYAPP: "KEY",
      APPLE_DC_KEY_P8_MYAPP: "P8",
    });
    expect(appConfig(env, "myapp")?.apple).toEqual({ teamId: "TEAM", keyId: "KEY", p8: "P8" });
  });

  it.each(["APPLE_TEAM_ID_MYAPP", "APPLE_KEY_ID_MYAPP", "APPLE_DC_KEY_P8_MYAPP"])(
    "sin %s no hay cliente de Apple: decide solo con D1",
    (missing) => {
      const vars: Record<string, string> = {
        HASH_PREFIX_MYAPP: "myapp-ban-v1",
        APPLE_TEAM_ID_MYAPP: "TEAM",
        APPLE_KEY_ID_MYAPP: "KEY",
        APPLE_DC_KEY_P8_MYAPP: "P8",
      };
      delete vars[missing];
      expect(appConfig(envOf(vars), "myapp")?.apple).toBeUndefined();
    },
  );

  it.each([
    ["true", true],
    ["TRUE", false],
    ["1", false],
    ["yes", false],
    ["false", false],
    [undefined, false],
  ])('ENFORCE_<APP>=%j: solo "true" exacto bloquea', (value, enforce) => {
    expect(appConfig(envOf({ HASH_PREFIX_MYAPP: "p", ENFORCE_MYAPP: value }), "myapp")?.enforce).toBe(enforce);
  });
});
