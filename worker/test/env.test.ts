import { describe, expect, it } from "vitest";
import { appConfig, isAppId, type GuardEnv } from "../src/env";

const envOf = (vars: Record<string, unknown>) => ({ DB: null, ...vars }) as unknown as GuardEnv;

describe("isAppId", () => {
  it.each(["demo", "myapp", "a", "0app", "my-app_2", "a".repeat(32)])("accepts %j", (app) => {
    expect(isAppId(app)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["uppercase", "Demo"],
    ["starts with a hyphen", "-app"],
    ["starts with an underscore", "_app"],
    ["33 characters", "a".repeat(33)],
    ["invalid leading character", "!myapp"],
    ["invalid trailing character", "myapp!"],
    ["path", "myapp/../x"],
    ["space", "ki st"],
    ["not a string even if it converts to a valid one", ["demo"]],
    ["number", 42],
    ["null", null],
  ])("rejects %s", (_name, app) => {
    expect(isAppId(app)).toBe(false);
  });
});

describe("appConfig", () => {
  it("no HASH_PREFIX_<APP>: null (the app responds 404)", () => {
    expect(appConfig(envOf({ HASH_PREFIX_OTHERAPP: "p" }), "myapp")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["not a string", 1],
    // In wrangler.jsonc, `vars` accepts JSON: an array has a `length` and must not slip through.
    ["JSON array", ["myapp-ban-v1"]],
  ])("HASH_PREFIX_<APP> %s counts as missing", (_name, value) => {
    expect(appConfig(envOf({ HASH_PREFIX_MYAPP: value }), "myapp")).toBeNull();
  });

  it("the suffix is the app uppercased, with hyphens as underscores", () => {
    const env = envOf({ HASH_PREFIX_MY_APP: "my-ban-v1", HASH_PREFIX_MYAPP: "other" });
    expect(appConfig(env, "my-app")?.hashPrefix).toBe("my-ban-v1");
  });

  it("reads only its own app's variables", () => {
    const env = envOf({
      HASH_PREFIX_MYAPP: "myapp-ban-v1",
      ENFORCE_OTHER: "true",
      APPLE_TEAM_ID_OTHER: "T",
      APPLE_KEY_ID_OTHER: "K",
      APPLE_DC_KEY_P8_OTHER: "P",
    });
    expect(appConfig(env, "myapp")).toEqual({ app: "myapp", hashPrefix: "myapp-ban-v1", enforce: false, apple: undefined });
  });

  it("with all three Apple variables, each one in its own field", () => {
    const env = envOf({
      HASH_PREFIX_MYAPP: "myapp-ban-v1",
      APPLE_TEAM_ID_MYAPP: "TEAM",
      APPLE_KEY_ID_MYAPP: "KEY",
      APPLE_DC_KEY_P8_MYAPP: "P8",
    });
    expect(appConfig(env, "myapp")?.apple).toEqual({ teamId: "TEAM", keyId: "KEY", p8: "P8" });
  });

  it.each(["APPLE_TEAM_ID_MYAPP", "APPLE_KEY_ID_MYAPP", "APPLE_DC_KEY_P8_MYAPP"])(
    "without %s there is no Apple client: decides with D1 alone",
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
  ])('ENFORCE_<APP>=%j: only an exact "true" blocks', (value, enforce) => {
    expect(appConfig(envOf({ HASH_PREFIX_MYAPP: "p", ENFORCE_MYAPP: value }), "myapp")?.enforce).toBe(enforce);
  });
});
