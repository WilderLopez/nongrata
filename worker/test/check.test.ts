import { describe, expect, it } from "vitest";
import { parseCheckRequest } from "../src/check";
import { refFromInstallHash } from "../src/hash";
import { FakeDeviceCheck, adminCall, check, guardEnv, logRows, randomHash, randomIds } from "./helpers";

const TOKEN = "dGVzdC10b2tlbi1xdWVyeQ==";
const TOKEN_UPDATE = "dGVzdC10b2tlbi11cGRhdGU=";

const ban = (app: string, kind: string, hash: string) =>
  adminCall("POST", "/v1/admin/ban", { app, kind, hash, note: "test" });

describe("POST /v1/device/check", () => {
  it("clean device: ok, with the ref derived from the install hash", async () => {
    const ids = randomIds();
    const dc = new FakeDeviceCheck();
    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(res).toEqual({ status: 200, body: { status: "ok", ref: refFromInstallHash(ids.install) } });
    expect(dc.writes()).toEqual([]);
  });

  it("ignores the ref sent by the client", async () => {
    const ids = randomIds();
    const res = await check({ ids, ref: "AAAAAAAA" } as never);
    expect(res.body.ref).toBe(refFromInstallHash(ids.install));
  });

  it("banned hash with bit0 false: writes bit0 with the second token and blocks", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck();

    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);

    expect(res.body.status).toBe("blocked");
    expect(dc.writes()).toEqual([{ op: "setBit0", env: "production", token: TOKEN_UPDATE, bit0: true }]);
    expect(dc.bits?.bit0).toBe(true);
  });

  // Apple asks not to reuse a token: with only one, the Worker queries, and bit0 is written on the
  // next check that carries both.
  it("no dc_token_update: blocks via D1 but does not write bit0 until it has both tokens", async () => {
    const ids = randomIds();
    await ban("demo", "install", ids.install);
    const dc = new FakeDeviceCheck();

    expect((await check({ dc_token: TOKEN, ids, env: "development" }, dc)).body.status).toBe("blocked");
    expect(dc.calls).toEqual([{ op: "query", env: "development", token: TOKEN }]);

    await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids, env: "development" }, dc);
    expect(dc.writes()).toEqual([{ op: "setBit0", env: "development", token: TOKEN_UPDATE, bit0: true }]);
  });

  it("unban without dc_token_update: lets the device in without writing or consuming the ref", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await ban("demo", "idfv", ids.idfv);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("ok");
    expect(dc.writes()).toEqual([]);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).toBeNull();
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "idfv", hash: ids.idfv });
    expect(row.body.banned).not.toBeNull();
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 1, bit0: 1, intent: "launch" }]);
  });

  it("bit0 already set: does not write it again", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck({ bit0: true });
    const res = await check({ dc_token: TOKEN, ids }, dc);
    expect(res.body.status).toBe("blocked");
    expect(dc.writes()).toEqual([]);
  });

  it("bit0 set with new identifiers: blocks and propagates them to D1", async () => {
    const ids = randomIds(); // reinstall after wiping the iPhone, with another Apple account
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("blocked");

    // Another device with the same iCloud account is blocked by D1 alone.
    const other = { ...randomIds(), icloud: ids.icloud };
    expect((await check({ ids: other })).body.status).toBe("blocked");

    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toMatchObject({ reason: "propagated", kind: "icloud" });
  });

  it("block by one hash: propagates the rest and blocks the other iPhone with the same iCloud account", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    expect((await check({ dc_token: TOKEN, ids }, new FakeDeviceCheck())).body.status).toBe("blocked");

    const otherPhone = { ...randomIds(), icloud: ids.icloud };
    expect((await check({ dc_token: TOKEN, ids: otherPhone }, new FakeDeviceCheck())).body.status).toBe("blocked");

    for (const kind of ["install", "icloud"] as const) {
      const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind, hash: ids[kind] });
      expect(row.body.banned).toMatchObject({ reason: "propagated" });
    }
  });

  it("device not blocked: propagates nothing", async () => {
    const ids = randomIds();
    await check({ dc_token: TOKEN, ids }, new FakeDeviceCheck());
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toBeNull();
  });

  it("propagation does not overwrite a manual mark", async () => {
    const ids = randomIds();
    await ban("demo", "icloud", ids.icloud);
    // Blocked by the manual hash: propagation inserts the rest without touching that one.
    await check({ dc_token: TOKEN, ids }, new FakeDeviceCheck({ bit0: true }));
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toMatchObject({ reason: "manual", note: "test" });
  });

  it("unban by ref: clears bit0, consumes the ref and responds ok", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    const dc = new FakeDeviceCheck({ bit0: true });
    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("blocked");

    // The ref is enough: the Worker deletes the hashes the device itself sends.
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });

    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(res.body.status).toBe("ok");
    expect(dc.bits?.bit0).toBe(false);
    expect(dc.writes().at(-1)).toMatchObject({ token: TOKEN_UPDATE, bit0: false });

    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).not.toBeNull();

    for (const [kind, hash] of Object.entries(ids)) {
      if (!hash) continue;
      const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind, hash });
      expect(row.body.banned).toBeNull();
    }

    // Next check: truly clean.
    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("ok");
  });

  it("unban with Apple down: lets the device in but does not consume the ref", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });
    dc.failing = true;

    expect((await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc)).body.status).toBe("ok");
    expect(dc.writes()).toHaveLength(1);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).toBeNull();
  });

  it("Apple down: decides with D1 alone", async () => {
    const banned = randomIds();
    await ban("demo", "idfv", banned.idfv);
    const dc = new FakeDeviceCheck({ bit0: true });
    dc.failing = true;

    expect((await check({ dc_token: TOKEN, ids: banned }, dc)).body.status).toBe("blocked");
    expect((await check({ dc_token: TOKEN, ids: randomIds() }, dc)).body.status).toBe("ok");
  });

  it("no dc_token (simulator): does not call Apple", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck();
    expect((await check({ dc_token: null, ids }, dc)).body.status).toBe("blocked");
    expect(dc.calls).toEqual([]);
  });

  it("observation mode: responds ok but logs blocked", async () => {
    const ids = randomIds();
    await ban("other", "idfv", ids.idfv);
    const res = await check({ app: "other", ids, intent: "login" });
    expect(res.body.status).toBe("ok");
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 1, matched: 1, bit0: null, intent: "login" },
    ]);
  });

  // Pure observation: reads D1 and Apple but changes nothing outside check_log. Once ENFORCE is
  // on, the first check of each banned device writes bit0 and propagates.
  it("observation mode with Apple: queries bit0 but neither writes it nor propagates", async () => {
    const ids = randomIds();
    await ban("other", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck();

    const res = await check({ app: "other", dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);

    expect(res.body.status).toBe("ok");
    expect(dc.calls).toEqual([{ op: "query", env: "production", token: TOKEN }]);
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "other", kind: "install", hash: ids.install });
    expect(row.body.banned).toBeNull();
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 1, matched: 1, bit0: 0, intent: "launch" },
    ]);
  });

  it("observation mode with bit0 set: logs blocked without propagating", async () => {
    const ids = randomIds();
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ app: "other", dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc)).body.status).toBe("ok");

    const row = await adminCall("GET", "/v1/admin/lookup", { app: "other", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toBeNull();
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 1, matched: 0, bit0: 1, intent: "launch" },
    ]);
  });

  it("per-app isolation: a ban in demo does not affect other", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    await check({ app: "other", ids });
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 0, matched: 0, bit0: null, intent: "launch" },
    ]);
  });

  it.each([
    ["no install", { ids: { idfv: null, install: null } }, 400],
    ["uppercase hash", { ids: { install: "A".repeat(64) } }, 400],
    ["unknown intent", { ids: { install: "a".repeat(64) }, intent: "hack" }, 400],
    ["token with line breaks", { ids: { install: "a".repeat(64) }, dc_token: "abc\ndefghijklmnopqrs" }, 400],
    ["app not configured", { app: "nope", ids: { install: "a".repeat(64) } }, 404],
  ])("rejects invalid requests: %s", async (_name, body, status) => {
    expect((await check(body as never)).status).toBe(status);
  });

  it("stores no raw identifiers or IPs in check_log", async () => {
    const { results } = await guardEnv.DB.prepare("PRAGMA table_info(check_log)").all<{ name: string }>();
    expect(results.map((c) => c.name).sort()).toEqual(
      ["app", "bit0", "blocked", "created_at", "intent", "matched", "ref"].sort(),
    );
  });
});

describe("parseCheckRequest", () => {
  const install = "a".repeat(64);
  const valid = { app: "demo", ids: { install } };

  it("minimal request: defaults and derived ref", () => {
    expect(parseCheckRequest(valid)).toEqual({
      app: "demo",
      env: "production",
      dcToken: null,
      dcTokenUpdate: null,
      ids: [{ kind: "install", hash: install }],
      ref: "AAAAAAAA",
      intent: "launch",
    });
  });

  it("reads the four iOS identifier kinds", () => {
    const ids = { idfv: "1".repeat(64), install, icloud: "2".repeat(64), user: "3".repeat(64) };
    expect(parseCheckRequest({ ...valid, ids })?.ids.map((id) => id.kind)).toEqual(["idfv", "install", "icloud", "user"]);
  });

  it.each([
    ["null body", null],
    ["string body", "demo"],
    ["invalid app", { ...valid, app: "Demo!" }],
    ["unknown env", { ...valid, env: "staging" }],
    ["null ids", { app: "demo", ids: null }],
    ["missing ids", { app: "demo" }],
    ["numeric dc_token", { ...valid, dc_token: 1234567890123456 }],
    ["dc_token with trailing garbage", { ...valid, dc_token: "dGVzdC10b2tlbi1xdWVyeQ==!" }],
    ["dc_token too long", { ...valid, dc_token: "a".repeat(8193) }],
    ["dc_token too short", { ...valid, dc_token: "a".repeat(15) }],
    ["invalid dc_token_update", { ...valid, dc_token: TOKEN, dc_token_update: "short" }],
    ["invalid idfv hash", { app: "demo", ids: { install, idfv: "x" } }],
  ])("rejects: %s", (_name, body) => {
    expect(parseCheckRequest(body)).toBeNull();
  });
});

describe("check: additional cases", () => {
  it("a ban by user blocks", async () => {
    const ids = { ...randomIds(), user: randomHash() };
    await ban("demo", "user", ids.user);
    expect((await check({ ids })).body.status).toBe("blocked");
  });

  it("app without an Apple key: the unban by ref is consumed with D1 alone", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await ban("demo", "idfv", ids.idfv);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });

    expect((await check({ ids })).body.status).toBe("ok");
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).not.toBeNull();
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 1, bit0: null, intent: "launch" }]);
    expect((await check({ ids })).body.status).toBe("ok");
  });

  // With an Apple key, an unban is only consumed once Apple confirms bit0 = false. If the check
  // arrives without dc_token (generateToken failed), it lets the device in and waits for one with a
  // token; if it were consumed, bit0 would stay set and the device would be blocked again.
  it("app with Apple and a check without dc_token: lets the device in but neither consumes nor deletes hashes", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    const dc = new FakeDeviceCheck({ bit0: true });
    await ban("demo", "idfv", ids.idfv);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });

    expect((await check({ dc_token: null, ids }, dc)).body.status).toBe("ok");
    expect(dc.calls).toEqual([]);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).toBeNull();
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "idfv", hash: ids.idfv });
    expect(row.body.banned).not.toBeNull();
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 1, bit0: null, intent: "launch" }]);

    // The next one, with a token: clears bit0, deletes the hashes and consumes the unban.
    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(res.body.status).toBe("ok");
    expect(dc.bits?.bit0).toBe(false);
    expect(dc.writes()).toEqual([{ op: "setBit0", env: "production", token: TOKEN_UPDATE, bit0: false }]);
    const after = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((after.body.unban as { consumed_at: number | null }).consumed_at).not.toBeNull();
    const gone = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "idfv", hash: ids.idfv });
    expect(gone.body.banned).toBeNull();

    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("ok");
  });

  it("check_log for the unban: bit0 = 0 if Apple cleared it", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, new FakeDeviceCheck({ bit0: true }));
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 0, bit0: 0, intent: "launch" }]);
  });

  it("check_log for the unban with Apple down: bit0 unknown", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });
    dc.failing = true;
    await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 0, bit0: null, intent: "launch" }]);
  });

  it.each([
    [true, 1, "blocked"],
    [false, 0, "ok"],
  ] as const)("check_log records the bit0 read from Apple (%s)", async (bit0, logged, status) => {
    const ids = randomIds();
    const res = await check({ dc_token: TOKEN, ids, intent: "foreground" }, new FakeDeviceCheck({ bit0 }));
    expect(res.body.status).toBe(status);
    expect(await logRows("demo", refFromInstallHash(ids.install))).toEqual([
      { blocked: logged, matched: 0, bit0: logged, intent: "foreground" },
    ]);
  });

  it("lookup by ref returns the checks, most recent first", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await check({ ids, intent: "launch" });
    await ban("demo", "idfv", ids.idfv);
    await check({ ids, intent: "login" });

    const { body } = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect(body.unban).toBeNull();
    expect((body.checks as Record<string, unknown>[]).map(({ created_at: _, ...c }) => c)).toEqual([
      { blocked: 1, matched: 1, bit0: null, intent: "login" },
      { blocked: 0, matched: 0, bit0: null, intent: "launch" },
    ]);
  });
});
