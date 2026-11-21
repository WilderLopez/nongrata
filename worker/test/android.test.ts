// A client without DeviceCheck: `platform: "android"` in POST /v1/device/check (docs/CHECK-API.md).
// Only that value changes anything; every other request takes the iOS path, unchanged.

import { describe, expect, it } from "vitest";
import { parseCheckRequest } from "../src/check";
import { refFromInstallHash } from "../src/hash";
import { FakeDeviceCheck, adminCall, check, guardEnv, logRows, randomHash, randomIds } from "./helpers";

const TOKEN = "dGVzdC10b2tlbi1xdWVyeQ==";
const TOKEN_UPDATE = "dGVzdC10b2tlbi11cGRhdGU=";

const androidIds = () => ({ install: randomHash(), user: null as string | null, android_id: randomHash() });

const ban = (app: string, kind: string, hash: string) =>
  adminCall("POST", "/v1/admin/ban", { app, kind, hash, note: "test" });

async function platforms(app: string, ref: string) {
  const { results } = await guardEnv.DB.prepare(
    "SELECT platform FROM check_log WHERE app = ? AND ref = ? ORDER BY rowid",
  )
    .bind(app, ref)
    .all<{ platform: string | null }>();
  return results.map((r) => r.platform);
}

describe("parseCheckRequest: platform", () => {
  const install = "a".repeat(64);
  const androidId = "b".repeat(64);
  const user = "c".repeat(64);

  it("android: reads install, user and android_id", () => {
    const req = parseCheckRequest({ app: "demo", platform: "android", ids: { install, user, android_id: androidId } });
    expect(req?.platform).toBe("android");
    expect(req?.ids).toEqual([
      { kind: "install", hash: install },
      { kind: "user", hash: user },
      { kind: "android_id", hash: androidId },
    ]);
  });

  it("android: install is still the only required id", () => {
    expect(parseCheckRequest({ app: "demo", platform: "android", ids: { install } })?.ids).toEqual([
      { kind: "install", hash: install },
    ]);
  });

  it.each([
    ["dc_token", { dc_token: TOKEN }],
    ["dc_token_update", { dc_token_update: TOKEN_UPDATE }],
    ["idfv", { ids: { install, idfv: "1".repeat(64) } }],
    ["icloud", { ids: { install, icloud: "2".repeat(64) } }],
    ["an invalid android_id hash", { ids: { install, android_id: "x" } }],
    ["no install", { ids: { android_id: androidId } }],
  ])("android rejects %s", (_name, extra) => {
    expect(parseCheckRequest({ app: "demo", platform: "android", ids: { install }, ...extra })).toBeNull();
  });

  it("android accepts the Apple fields as null", () => {
    const body = { app: "demo", platform: "android", dc_token: null, dc_token_update: null, ids: { install, idfv: null, icloud: null } };
    expect(parseCheckRequest(body)?.ids).toEqual([{ kind: "install", hash: install }]);
  });

  // The Swift SDK sends platform "ios"; any value but "android" is the request of today.
  it.each([["ios"], ["iOS"], ["windows"], [""], [42], [null], [undefined]])(
    "platform %j: the iOS path, android_id ignored as before",
    (platform) => {
      const req = parseCheckRequest({ app: "demo", platform, dc_token: TOKEN, ids: { install, android_id: androidId } });
      expect(req).not.toBeNull();
      expect(req?.platform).toBeUndefined();
      expect(req?.ids).toEqual([{ kind: "install", hash: install }]);
    },
  );
});

describe("check from Android", () => {
  it("clean device: ok, ref from the install hash, logged as android", async () => {
    const ids = androidIds();
    const ref = refFromInstallHash(ids.install);
    expect(await check({ platform: "android", ids })).toEqual({ status: 200, body: { status: "ok", ref } });
    expect(await platforms("demo", ref)).toEqual(["android"]);
  });

  it("a ban by android_id blocks", async () => {
    const ids = androidIds();
    await ban("demo", "android_id", ids.android_id);
    expect((await check({ platform: "android", ids })).body.status).toBe("blocked");
  });

  // ANDROID_ID survives a reinstall; the install id does not. The blocked device propagated its
  // android_id, so the reinstalled app (new install, same android_id) is still blocked.
  it("reinstall: a device banned by install stays blocked through its android_id", async () => {
    const ids = androidIds();
    await ban("demo", "install", ids.install);
    expect((await check({ platform: "android", ids })).body.status).toBe("blocked");

    const reinstalled = { ...ids, install: randomHash() };
    expect((await check({ platform: "android", ids: reinstalled })).body.status).toBe("blocked");
  });

  it("the list is shared with iOS: a ban by user blocks the person on both platforms", async () => {
    const user = randomHash();
    await ban("demo", "user", user);
    expect((await check({ platform: "android", ids: { ...androidIds(), user } })).body.status).toBe("blocked");
    expect((await check({ ids: { ...randomIds(), user } })).body.status).toBe("blocked");
  });

  it("app with an Apple key: Apple is never called for an Android device", async () => {
    const ids = androidIds();
    await ban("demo", "android_id", ids.android_id);
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ platform: "android", ids }, dc)).body.status).toBe("blocked");
    expect(dc.calls).toEqual([]);
    expect(await logRows("demo", refFromInstallHash(ids.install))).toEqual([
      { blocked: 1, matched: 1, bit0: null, intent: "launch" },
    ]);
  });

  // An Android device has no bit0 to clear, so its unban is consumed with D1 alone even when the
  // app has an Apple key. For iOS nothing changes: the test "app with Apple and a check without
  // dc_token" in check.test.ts still holds.
  it("app with an Apple key: the unban by ref is consumed with D1 alone", async () => {
    const ids = androidIds();
    const ref = refFromInstallHash(ids.install);
    await ban("demo", "android_id", ids.android_id);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ platform: "android", ids }, dc)).body.status).toBe("ok");
    expect(dc.calls).toEqual([]);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).not.toBeNull();
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "android_id", hash: ids.android_id });
    expect(row.body.banned).toBeNull();
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 1, bit0: null, intent: "launch" }]);
    expect((await check({ platform: "android", ids }, dc)).body.status).toBe("ok");
  });

  it("the same iOS request without tokens still waits for them (the iOS path is unchanged)", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await ban("demo", "idfv", ids.idfv);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ platform: undefined, ids }, dc)).body.status).toBe("ok");
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).toBeNull();
  });

  it("observation mode: ok, logs blocked and does not propagate", async () => {
    const ids = androidIds();
    await ban("other", "install", ids.install);
    const ref = refFromInstallHash(ids.install);

    expect((await check({ app: "other", platform: "android", ids })).body.status).toBe("ok");
    expect(await logRows("other", ref)).toEqual([{ blocked: 1, matched: 1, bit0: null, intent: "launch" }]);
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "other", kind: "android_id", hash: ids.android_id });
    expect(row.body.banned).toBeNull();
  });

  it.each([
    ["dc_token", { dc_token: TOKEN }],
    ["idfv", { ids: { ...androidIds(), idfv: randomHash() } }],
  ])("an Android request with %s is a 400", async (_name, extra) => {
    expect((await check({ platform: "android", ids: androidIds(), ...extra })).status).toBe(400);
  });
});

describe("check_log platform", () => {
  it.each([
    ["ios", "ios"],
    ["windows", "ios"],
    [undefined, "ios"],
    ["android", "android"],
  ] as const)("platform %s is logged as %s", async (platform, logged) => {
    const ids = platform === "android" ? androidIds() : randomIds();
    await check({ platform, ids });
    expect(await platforms("demo", refFromInstallHash(ids.install))).toEqual([logged]);
  });

  it("the admin listing and the lookup by ref carry it", async () => {
    const ids = androidIds();
    const ref = refFromInstallHash(ids.install);
    await check({ platform: "android", ids, intent: "login" });

    const list = await adminCall("GET", "/v1/admin/checks", { app: "demo", ref });
    expect(list.body.items).toEqual([
      { ref, blocked: 0, matched: 0, bit0: null, intent: "login", platform: "android", created_at: expect.any(Number) },
    ]);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect(lookup.body.checks).toEqual([
      { blocked: 0, matched: 0, bit0: null, intent: "login", platform: "android", created_at: expect.any(Number) },
    ]);
  });
});
