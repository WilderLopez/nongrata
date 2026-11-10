// Signed requests from admin devices (docs/DEVICE-PAIRING.md, sections 3 to 5): the checks of
// section 3.4 in order, the role table, revocation and the device endpoints.

import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "../../spec/device-signature-vectors.json";
import { allows } from "../src/devices";
import type { GuardEnv } from "../src/env";
import {
  newKey,
  nonceCount,
  pairDevice,
  randomB64,
  send,
  setPairingExpiry,
  signedCall,
  tokenCall,
  TOKEN,
  deviceRow,
} from "./device-helpers";
import { guardEnv, randomHash } from "./helpers";

const UNAUTHORIZED = { status: 401, body: { error: "unauthorized" } };
const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

/** An app configured only in this test's env, so its listings start empty. */
function freshApp() {
  const app = `d${randomHash().slice(0, 12)}`;
  const env = { ...guardEnv, [`HASH_PREFIX_${app.toUpperCase()}`]: `${app}-ban-v1` } as GuardEnv;
  return { app, env };
}

describe("happy paths", () => {
  it("a read device: me, apps and the read routes", async () => {
    const device = await pairDevice("read");
    const me = await signedCall(device, "GET", "/v1/admin/me");
    expect(me).toEqual({
      status: 200,
      body: {
        device_id: device.id,
        name: "iPhone 16 Pro",
        platform: "ios",
        role: "read",
        status: "active",
        created_at: expect.any(Number),
      },
    });
    expect((await signedCall(device, "GET", "/v1/admin/apps")).status).toBe(200);
    expect((await signedCall(device, "GET", "/v1/admin/bans?app=demo&limit=1")).status).toBe(200);
    expect((await signedCall(device, "GET", "/v1/admin/checks?app=demo&limit=1")).status).toBe(200);
    expect((await signedCall(device, "GET", "/v1/admin/log?app=demo&limit=1")).status).toBe(200);
    expect((await signedCall(device, "GET", "/v1/admin/lookup?app=demo&ref=A1B2C3D4")).status).toBe(200);
  });

  it("an admin device bans and unbans, and the log names it as actor", async () => {
    const { app, env } = freshApp();
    const device = await pairDevice("admin");
    const hash = randomHash();
    const ban = JSON.stringify({ app, kind: "user", hash, note: "spam" });
    expect(await signedCall(device, "POST", "/v1/admin/ban", { body: ban, env })).toEqual({
      status: 200,
      body: { app, kind: "user", hash },
    });
    const unban = JSON.stringify({ app, ref: "A1B2C3D4" });
    expect((await signedCall(device, "POST", "/v1/admin/unban", { body: unban, env })).status).toBe(200);

    const log = await signedCall(device, "GET", `/v1/admin/log?app=${app}`, { env });
    const items = (log.body.items as Record<string, unknown>[]).filter((i) => i.action === "ban" || i.action === "unban");
    expect(items.map((i) => [i.action, i.actor, i.device_id])).toEqual([
      ["unban", `device:${device.id}`, null],
      ["ban", `device:${device.id}`, null],
    ]);
  });

  it("an admin device lists devices and revokes another one", async () => {
    const admin = await pairDevice("admin");
    const other = await pairDevice("read");
    const list = await signedCall(admin, "GET", "/v1/admin/devices");
    expect(list.status).toBe(200);
    const ids = (list.body.devices as { device_id: string }[]).map((d) => d.device_id);
    expect(ids).toContain(admin.id);
    expect(ids).toContain(other.id);
    const res = await signedCall(admin, "POST", `/v1/admin/devices/${other.id}/revoke`);
    expect(res).toEqual({ status: 200, body: { device_id: other.id, revoked_at: expect.any(Number) } });
    expect(await signedCall(other, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
  });

  it("the query and the body are covered; a POST body is still readable by the route", async () => {
    const { app, env } = freshApp();
    const device = await pairDevice("admin");
    const body = JSON.stringify({ app, kind: "idfv", value: "E621E1F8-C36C" });
    const res = await signedCall(device, "POST", "/v1/admin/ban", { body, env });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("idfv");
  });
});

describe("role table (section 4)", () => {
  const tokenOnly = (id: string): [string, string][] => [
    ["POST", "/v1/admin/pairings"],
    ["GET", `/v1/admin/pairings/${id}`],
    ["POST", `/v1/admin/pairings/${id}/approve`],
    ["DELETE", `/v1/admin/pairings/${id}`],
  ];

  it("a read device may not ban, unban, list devices or revoke another device", async () => {
    const device = await pairDevice("read");
    const other = await pairDevice("read");
    const body = JSON.stringify({ app: "demo", kind: "user", hash: randomHash() });
    expect(await signedCall(device, "POST", "/v1/admin/ban", { body })).toEqual(FORBIDDEN);
    expect(await signedCall(device, "POST", "/v1/admin/unban", { body })).toEqual(FORBIDDEN);
    expect(await signedCall(device, "GET", "/v1/admin/devices")).toEqual(FORBIDDEN);
    expect(await signedCall(device, "POST", `/v1/admin/devices/${other.id}/revoke`)).toEqual(FORBIDDEN);
    expect((await deviceRow(other.id))!.revoked_at).toBeNull();
  });

  it("any device may revoke itself, a read one too", async () => {
    const device = await pairDevice("read");
    expect((await signedCall(device, "POST", `/v1/admin/devices/${device.id}/revoke`)).status).toBe(200);
    expect(await signedCall(device, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
  });

  it("no device may create, read, approve or cancel pairings, an admin one neither", async () => {
    const admin = await pairDevice("admin");
    for (const [method, path] of tokenOnly(admin.pairing.id)) {
      const body = method === "POST" ? JSON.stringify({ role: "admin" }) : undefined;
      expect(await signedCall(admin, method, path, { body })).toEqual(FORBIDDEN);
    }
  });

  it("the token may not call me: it is not a device", async () => {
    expect(await tokenCall("GET", "/v1/admin/me")).toEqual(FORBIDDEN);
  });

  it("the token may call apps, devices and revoke", async () => {
    expect((await tokenCall("GET", "/v1/admin/apps")).status).toBe(200);
    expect((await tokenCall("GET", "/v1/admin/devices")).status).toBe(200);
    const device = await pairDevice("read");
    expect((await tokenCall("POST", `/v1/admin/devices/${device.id}/revoke`)).status).toBe(200);
  });

  it("a forbidden request does not count as use", async () => {
    const device = await pairDevice("read");
    expect(await signedCall(device, "GET", "/v1/admin/devices")).toEqual(FORBIDDEN);
    expect((await deviceRow(device.id))!.last_used_at).toBeNull();
  });
});

describe("allows(): the role table as a function", () => {
  const device = (role: "read" | "admin") =>
    ({
      kind: "device",
      device: { id: "D", name: "n", platform: "ios", role, public_key: "", status: "active", created_at: 0, last_used_at: null, revoked_at: null },
    }) as const;

  it.each([
    ["me", [false, true, true]],
    ["read", [true, true, true]],
    ["admin", [true, false, true]],
    ["token", [true, false, false]],
  ] as const)("%s: token, read device, admin device", (access, expected) => {
    expect([allows({ kind: "token" }, access), allows(device("read"), access), allows(device("admin"), access)]).toEqual(expected);
  });

  it("a pending device: only me", () => {
    const pending = { kind: "device", device: { ...device("admin").device, status: "pending" } } as const;
    expect((["me", "read", "admin", "revoke", "token"] as const).map((a) => allows(pending, a, "D"))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("revoke: the token, an admin device, or the device itself", () => {
    expect(allows({ kind: "token" }, "revoke", "X")).toBe(true);
    expect(allows(device("admin"), "revoke", "X")).toBe(true);
    expect(allows(device("read"), "revoke", "X")).toBe(false);
    expect(allows(device("read"), "revoke", "D")).toBe(true);
  });
});

describe("rejections (section 3.4)", () => {
  it("both credentials: 400 ambiguous credentials, whatever the token", async () => {
    const device = await pairDevice("admin");
    for (const token of [TOKEN, "nope"]) {
      const res = await signedCall(device, "GET", "/v1/admin/me", { headers: { authorization: `Bearer ${token}` } });
      expect(res).toEqual({ status: 400, body: { error: "ambiguous credentials" } });
    }
    expect(await nonceCount(device.id)).toBe(0);
  });

  it("an unknown device", async () => {
    const ghost = { id: randomB64(16), key: await newKey() };
    expect(await signedCall(ghost, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
  });

  it("a revoked device", async () => {
    const device = await pairDevice("admin");
    await tokenCall("POST", `/v1/admin/devices/${device.id}/revoke`);
    expect(await signedCall(device, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
    expect(await signedCall(device, "GET", "/v1/admin/bans?app=demo")).toEqual(UNAUTHORIZED);
  });

  it("a pending device may call only me (403 elsewhere), until it is approved", async () => {
    const device = await pairDevice("admin", false);
    expect((await signedCall(device, "GET", "/v1/admin/me")).body.status).toBe("pending");
    expect(await signedCall(device, "GET", "/v1/admin/bans?app=demo")).toEqual(FORBIDDEN);
    expect(await signedCall(device, "GET", "/v1/admin/apps")).toEqual(FORBIDDEN);
    expect(await signedCall(device, "POST", "/v1/admin/ban", { body: '{"app":"demo"}' })).toEqual(FORBIDDEN);
    expect(await signedCall(device, "GET", "/v1/admin/nope")).toEqual({ status: 404, body: { error: "not_found" } });
    await tokenCall("POST", `/v1/admin/pairings/${device.pairing.id}/approve`);
    expect((await signedCall(device, "GET", "/v1/admin/me")).body.status).toBe("active");
    expect((await signedCall(device, "GET", "/v1/admin/bans?app=demo")).status).toBe(200);
  });

  it("a pending device whose pairing expired or was cancelled gets 401, on me and elsewhere", async () => {
    const expired = await pairDevice("admin", false);
    await setPairingExpiry(expired.pairing.id, Date.now() - 1);
    expect(await signedCall(expired, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
    expect(await signedCall(expired, "GET", "/v1/admin/apps")).toEqual(UNAUTHORIZED);

    const cancelled = await pairDevice("admin", false);
    await tokenCall("DELETE", `/v1/admin/pairings/${cancelled.pairing.id}`);
    expect(await signedCall(cancelled, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
  });

  it("a pending device passes on me while its pairing lives, up to its expiry", async () => {
    const T = 1_800_000_000_000;
    const device = await pairDevice("admin", false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    await setPairingExpiry(device.pairing.id, T);
    expect((await signedCall(device, "GET", "/v1/admin/me")).status).toBe(200);
    await setPairingExpiry(device.pairing.id, T - 1);
    expect(await signedCall(device, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
  });

  it("a signature by another key", async () => {
    const device = await pairDevice("admin");
    const other = await newKey();
    expect(await signedCall(device, "GET", "/v1/admin/me", { key: other.privateKey })).toEqual(UNAUTHORIZED);
    expect(await nonceCount(device.id)).toBe(0);
  });

  it.each([
    ["another host", "GET", "/v1/admin/me", { signedHost: "other.test" }],
    ["another method", "GET", "/v1/admin/me", { signedMethod: "POST" }],
    ["another path", "GET", "/v1/admin/me", { signedPath: "/v1/admin/apps" }],
    ["another query", "GET", "/v1/admin/bans?app=demo&limit=2", { signedQuery: "app=demo&limit=1" }],
    ["no query", "GET", "/v1/admin/bans?app=demo", { signedQuery: "" }],
    ["another body", "POST", "/v1/admin/ban", { body: '{"app":"demo"}', signedBody: '{"app":"other"}' }],
    ["no body", "POST", "/v1/admin/ban", { body: '{"app":"demo"}', signedBody: "" }],
  ])("signed for %s", async (_name, method, path, options) => {
    const device = await pairDevice("admin");
    expect(await signedCall(device, method, path, options)).toEqual(UNAUTHORIZED);
    expect(await nonceCount(device.id)).toBe(0);
  });

  it("a replayed nonce: the same request twice", async () => {
    const device = await pairDevice("admin");
    const nonce = randomB64(16);
    const timestamp = Date.now();
    expect((await signedCall(device, "GET", "/v1/admin/me", { nonce, timestamp })).status).toBe(200);
    expect(await signedCall(device, "GET", "/v1/admin/me", { nonce, timestamp })).toEqual(UNAUTHORIZED);
    // The same nonce is fine for another device.
    const other = await pairDevice("admin");
    expect((await signedCall(other, "GET", "/v1/admin/me", { nonce })).status).toBe(200);
  });

  it.each([
    ["missing NonGrata-Timestamp", { "nongrata-timestamp": null }],
    ["missing NonGrata-Nonce", { "nongrata-nonce": null }],
    ["missing NonGrata-Signature", { "nongrata-signature": null }],
    ["a timestamp that is not a decimal integer", { "nongrata-timestamp": "1.7e12" }],
    ["a negative timestamp", { "nongrata-timestamp": "-1" }],
    ["a timestamp of 16 digits", { "nongrata-timestamp": "1".repeat(16) }],
    ["an empty timestamp", { "nongrata-timestamp": "" }],
    ["a nonce of 15 bytes", { "nongrata-nonce": randomB64(15) }],
    ["a signature of 63 bytes", { "nongrata-signature": randomB64(63) }],
    ["a DER signature", { "nongrata-signature": vectors.requests[0]!.signature_der }],
    ["a device id of 15 bytes", { "nongrata-device": randomB64(15) }],
    ["an empty device id", { "nongrata-device": "" }],
  ])("%s", async (_name, headers) => {
    const device = await pairDevice("admin");
    expect(await signedCall(device, "GET", "/v1/admin/me", { headers })).toEqual(UNAUTHORIZED);
    expect(await nonceCount(device.id)).toBe(0);
  });

  it("IDs and nonces must be 16 bytes even when the signature over them verifies", async () => {
    const device = await pairDevice("admin");
    expect(await signedCall(device, "GET", "/v1/admin/me", { nonce: randomB64(15) })).toEqual(UNAUTHORIZED);
    expect(await signedCall(device, "GET", "/v1/admin/me", { nonce: randomB64(17) })).toEqual(UNAUTHORIZED);
    // A device row whose id is 15 bytes (it could not come from a claim).
    const key = await newKey();
    const odd = { id: randomB64(15), key };
    await guardEnv.DB.prepare(
      `INSERT INTO admin_devices (id, name, platform, role, public_key, status, created_at)
       VALUES (?, 'odd', 'ios', 'admin', ?, 'active', ?)`,
    )
      .bind(odd.id, key.publicKey, Date.now())
      .run();
    expect(await signedCall(odd, "GET", "/v1/admin/me")).toEqual(UNAUTHORIZED);
    expect(await nonceCount(odd.id)).toBe(0);
  });

  it("an unknown admin route answers 401 before 404, also with a device header", async () => {
    expect(await send("GET", "/v1/admin/nope", { headers: { "nongrata-device": randomB64(16) } })).toEqual(UNAUTHORIZED);
    const device = await pairDevice("admin");
    expect(await signedCall(device, "GET", "/v1/admin/nope")).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("the clock (section 3.4, step 2)", () => {
  const T = 1_800_000_000_000;

  it.each([
    ["5 minutes behind", -5 * MINUTE, 200],
    ["5 minutes ahead", 5 * MINUTE, 200],
    ["5 minutes and 1 ms behind", -5 * MINUTE - 1, 401],
    ["5 minutes and 1 ms ahead", 5 * MINUTE + 1, 401],
  ])("%s: %i", async (_name, offset, status) => {
    const device = await pairDevice("admin");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const res = await signedCall(device, "GET", "/v1/admin/me", { timestamp: T + offset });
    expect(res.status).toBe(status);
    if (status === 401) {
      expect(res.body).toEqual({ error: "unauthorized", reason: "clock", server_time: T });
      expect(await nonceCount(device.id)).toBe(0);
    }
  });

  it("a stale timestamp of an unknown or revoked device says nothing about the clock", async () => {
    const ghost = { id: randomB64(16), key: await newKey() };
    expect(await signedCall(ghost, "GET", "/v1/admin/me", { timestamp: 0 })).toEqual(UNAUTHORIZED);
  });

  it("the clock is checked before the signature", async () => {
    const device = await pairDevice("admin");
    const res = await signedCall(device, "GET", "/v1/admin/me", { timestamp: Date.now() - 10 * MINUTE, key: (await newKey()).privateKey });
    expect(res.body.reason).toBe("clock");
  });
});

describe("nonces and last_used_at", () => {
  const T = 1_800_000_000_000;

  it("the nonce is kept until timestamp + 10 minutes; the device's expired ones go on the next insert", async () => {
    const device = await pairDevice("admin");
    const other = await pairDevice("admin");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const insert = guardEnv.DB.prepare("INSERT INTO admin_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)");
    await guardEnv.DB.batch([
      insert.bind(device.id, "expired", T - 1),
      insert.bind(device.id, "edge", T),
      insert.bind(other.id, "expired", T - 1),
    ]);
    const nonce = randomB64(16);
    expect((await signedCall(device, "GET", "/v1/admin/me", { nonce, timestamp: T - MINUTE })).status).toBe(200);
    const { results } = await guardEnv.DB.prepare(
      "SELECT nonce, expires_at FROM admin_nonces WHERE device_id = ? ORDER BY nonce",
    )
      .bind(device.id)
      .all();
    expect(results).toEqual(
      [
        { nonce: "edge", expires_at: T },
        { nonce, expires_at: T - MINUTE + 10 * MINUTE },
      ].sort((a, b) => (a.nonce < b.nonce ? -1 : 1)),
    );
    expect(await nonceCount(other.id)).toBe(1);
  });

  it("last_used_at is written on the first use, then at most once a minute", async () => {
    const device = await pairDevice("admin");
    expect((await deviceRow(device.id))!.last_used_at).toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = async (t: number) => {
      vi.setSystemTime(t);
      expect((await signedCall(device, "GET", "/v1/admin/me", { timestamp: t })).status).toBe(200);
      return (await deviceRow(device.id))!.last_used_at;
    };
    expect(await at(T)).toBe(T);
    expect(await at(T + MINUTE - 1)).toBe(T);
    expect(await at(T + MINUTE)).toBe(T + MINUTE);
  });

  it("the token does not touch any device", async () => {
    const device = await pairDevice("admin");
    await tokenCall("GET", "/v1/admin/devices");
    expect((await deviceRow(device.id))!.last_used_at).toBeNull();
  });
});

describe("GET /v1/admin/apps", () => {
  it("the configured apps, sorted, with enforce and whether DeviceCheck is set", async () => {
    expect(await tokenCall("GET", "/v1/admin/apps")).toEqual({
      status: 200,
      body: {
        apps: [
          { app: "demo", enforce: true, devicecheck: true },
          { app: "other", enforce: false, devicecheck: false },
        ],
      },
    });
  });

  it("the app is the variable's suffix in lowercase; invalid or empty ones are left out", async () => {
    const env = {
      DB: guardEnv.DB,
      ADMIN_TOKEN: TOKEN,
      HASH_PREFIX_ZETA: "z",
      HASH_PREFIX_MY_APP: "m",
      ENFORCE_MY_APP: "true",
      HASH_PREFIX_EMPTY: "",
      "HASH_PREFIX_BAD!": "b",
      HASH_PREFIX_: "x",
      XHASH_PREFIX_NOPE: "n",
      // 12 characters and then ZETA, like HASH_PREFIX_ZETA: only the prefix makes an app.
      NOT_A_PREFIXZETA: "n",
      APPLE_TEAM_ID_ZETA: "T",
      APPLE_KEY_ID_ZETA: "K",
    } as unknown as GuardEnv;
    expect((await tokenCall("GET", "/v1/admin/apps", undefined, env)).body).toEqual({
      apps: [
        { app: "my_app", enforce: true, devicecheck: false },
        { app: "zeta", enforce: false, devicecheck: false },
      ],
    });
  });
});

describe("GET /v1/admin/devices", () => {
  it("every device with its fields, never the public key, newest first", async () => {
    const insert = guardEnv.DB.prepare(
      `INSERT INTO admin_devices (id, name, platform, role, public_key, status, created_at, last_used_at, revoked_at)
       VALUES (?, ?, 'macos', 'read', 'PK', ?, ?, ?, ?)`,
    );
    const far = 4_000_000_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const [a, b, c] = ["A", "B", "C"].map((x) => `${x}${randomB64(16).slice(1)}`) as [string, string, string];
    await guardEnv.DB.batch([
      insert.bind(a, "Mac A", "active", far, far + 5, null),
      insert.bind(b, "Mac B", "pending", far + 1, null, null),
      insert.bind(c, "Mac C", "active", far, null, far + 9),
    ]);
    const res = await tokenCall("GET", "/v1/admin/devices");
    const mine = (res.body.devices as Record<string, unknown>[]).filter((d) => [a, b, c].includes(d.device_id as string));
    // Same created_at: the higher id first ("C…" > "A…").
    expect(mine).toEqual([
      { device_id: b, name: "Mac B", platform: "macos", role: "read", status: "pending", created_at: far + 1, last_used_at: null, revoked_at: null },
      { device_id: c, name: "Mac C", platform: "macos", role: "read", status: "active", created_at: far, last_used_at: null, revoked_at: far + 9 },
      { device_id: a, name: "Mac A", platform: "macos", role: "read", status: "active", created_at: far, last_used_at: far + 5, revoked_at: null },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("public_key");
  });
});

describe("POST /v1/admin/devices/{id}/revoke", () => {
  it("sets revoked_at and logs a revoke with the actor", async () => {
    const { app, env } = freshApp();
    const admin = await pairDevice("admin");
    const target = await pairDevice("read");
    const before = Date.now();
    const res = await signedCall(admin, "POST", `/v1/admin/devices/${target.id}/revoke`, { env });
    expect(res.status).toBe(200);
    const revokedAt = (await deviceRow(target.id))!.revoked_at as number;
    expect(revokedAt).toBeGreaterThanOrEqual(before);
    expect(res.body).toEqual({ device_id: target.id, revoked_at: revokedAt });

    // pair and revoke concern the whole Worker: they are in the log without app, not in an app's.
    const appLog = await tokenCall("GET", `/v1/admin/log?app=${app}`, undefined, env);
    expect(appLog.body).toEqual({ app, items: [], next_cursor: null });
    const log = await tokenCall("GET", "/v1/admin/log?limit=100", undefined, env);
    expect(log.body.app).toBeNull();
    const items = (log.body.items as Record<string, unknown>[]).filter((i) => i.device_id === target.id);
    expect(items).toEqual([
      { action: "revoke", kind: null, hash: null, ref: null, note: null, device_id: target.id, actor: `device:${admin.id}`, created_at: revokedAt },
      { action: "pair", kind: null, hash: null, ref: null, note: null, device_id: target.id, actor: "token", created_at: expect.any(Number) },
    ]);
  });

  it("idempotent: a second revoke answers the original revoked_at, and only one log row", async () => {
    const device = await pairDevice("read");
    const first = await tokenCall("POST", `/v1/admin/devices/${device.id}/revoke`);
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await tokenCall("POST", `/v1/admin/devices/${device.id}/revoke`)).toEqual(first);
    expect((await deviceRow(device.id))!.revoked_at).toBe(first.body.revoked_at);
    const { results } = await guardEnv.DB.prepare("SELECT action FROM admin_log WHERE device_id = ? AND action = 'revoke'")
      .bind(device.id)
      .all();
    expect(results).toHaveLength(1);
  });

  it("an unknown device: 404 not_found", async () => {
    expect(await tokenCall("POST", `/v1/admin/devices/${randomB64(16)}/revoke`)).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });
});

describe("GET /v1/admin/log without app: the Worker's device events", () => {
  it("only pair and revoke, newest first, paged; never an app's ban", async () => {
    const T = 5_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000) * 100;
    const ids = [randomB64(16), randomB64(16), randomB64(16)];
    const insert = guardEnv.DB.prepare(
      `INSERT INTO admin_log (app, action, kind, hash, ref, note, created_at, device_id, actor)
       VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, 'token')`,
    );
    await guardEnv.DB.batch([
      insert.bind(null, "pair", T, ids[0]),
      insert.bind(null, "revoke", T + 2, ids[0]),
      insert.bind(null, "pair", T + 1, ids[1]),
      insert.bind("demo", "ban", T + 3, null),
    ]);
    const first = await tokenCall("GET", "/v1/admin/log?limit=2");
    expect(first.status).toBe(200);
    const items = first.body.items as Record<string, unknown>[];
    // Far in the future, so they are the newest rows of the shared D1.
    expect(items).toEqual([
      { action: "revoke", kind: null, hash: null, ref: null, note: null, device_id: ids[0], actor: "token", created_at: T + 2 },
      { action: "pair", kind: null, hash: null, ref: null, note: null, device_id: ids[1], actor: "token", created_at: T + 1 },
    ]);
    const second = await tokenCall("GET", `/v1/admin/log?limit=1&cursor=${first.body.next_cursor}`);
    expect((second.body.items as Record<string, unknown>[])[0]).toMatchObject({ action: "pair", device_id: ids[0] });
    // The app's log has its ban and none of the device events.
    const demo = await tokenCall("GET", "/v1/admin/log?app=demo&limit=1");
    expect((demo.body.items as Record<string, unknown>[])[0]).toMatchObject({ action: "ban", created_at: T + 3 });
    await guardEnv.DB.prepare("DELETE FROM admin_log WHERE created_at >= ?").bind(T).run();
  });

  it("a present but bad app is still an error; limit and cursor are checked", async () => {
    expect(await tokenCall("GET", "/v1/admin/log?app=Demo!")).toEqual({ status: 400, body: { error: "invalid app" } });
    expect(await tokenCall("GET", "/v1/admin/log?app=kits")).toEqual({ status: 400, body: { error: "app not configured" } });
    expect(await tokenCall("GET", "/v1/admin/log?limit=0")).toEqual({ status: 400, body: { error: "invalid limit" } });
  });

  it("a read device may read it", async () => {
    const device = await pairDevice("read");
    expect((await signedCall(device, "GET", "/v1/admin/log")).status).toBe(200);
  });
});

describe("routing of the new admin routes", () => {
  it.each([
    ["PUT", "/v1/admin/pairings/x"],
    ["GET", "/v1/admin/pairings/x/approve"],
    ["POST", "/v1/admin/pairings/x/y"],
    ["GET", "/v1/admin/pairings/"],
    ["POST", "/v1/admin/pairings/x/approve/y"],
    ["GET", "/v1/admin/devices/x/revoke"],
    ["POST", "/v1/admin/devices/x/revoke/y"],
    ["POST", "/v1/admin/devices//revoke"],
    ["POST", "/v1/admin/x/devices/y/revoke"],
    ["GET", "/v1/admin/x/pairings/y"],
    // The patterns are anchored at both ends.
    ["GET", "/v1/admin/x/v1/admin/pairings/y"],
    ["DELETE", "/v1/admin/x/v1/admin/pairings/y"],
    ["DELETE", "/v1/admin/pairings/x/y"],
    ["POST", "/v1/admin/x/v1/admin/pairings/y/approve"],
    ["POST", "/v1/admin/x/v1/admin/devices/y/revoke"],
    ["POST", "/v1/admin/me"],
    ["POST", "/v1/admin/apps"],
    ["DELETE", "/v1/admin/devices"],
  ])("%s %s with the token: 404", async (method, path) => {
    expect(await tokenCall(method, path)).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("a revoke path with something before or after does not revoke a real device", async () => {
    const device = await pairDevice("read");
    for (const path of [`/v1/admin/x/v1/admin/devices/${device.id}/revoke`, `/v1/admin/devices/${device.id}/revoke/x`]) {
      expect(await tokenCall("POST", path)).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect((await deviceRow(device.id))!.revoked_at).toBeNull();
  });

  it("every one of them answers 401 without credentials", async () => {
    const id = randomB64(16);
    for (const [method, path] of [
      ["POST", "/v1/admin/pairings"],
      ["GET", `/v1/admin/pairings/${id}`],
      ["DELETE", `/v1/admin/pairings/${id}`],
      ["POST", `/v1/admin/pairings/${id}/approve`],
      ["GET", "/v1/admin/me"],
      ["GET", "/v1/admin/apps"],
      ["GET", "/v1/admin/devices"],
      ["POST", `/v1/admin/devices/${id}/revoke`],
    ] as const) {
      expect(await send(method, path)).toEqual(UNAUTHORIZED);
    }
  });
});
