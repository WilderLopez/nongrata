import { describe, expect, it } from "vitest";
import vectors from "../../spec/hash-vectors.json";
import type { GuardEnv } from "../src/env";
import { handle } from "../src/index";
import { adminCall, check, guardEnv, randomHash } from "./helpers";

describe("admin", () => {
  it.each([
    ["no token", null],
    ["wrong token", "nope"],
  ])("401 %s", async (_name, token) => {
    const res = await adminCall("POST", "/v1/admin/ban", { app: "demo", kind: "idfv", value: "x" }, token);
    expect(res.status).toBe(401);
  });

  it("ban with value: the Worker computes the hash with the app's prefix", async () => {
    const res = await adminCall("POST", "/v1/admin/ban", {
      app: "demo",
      kind: "idfv",
      value: "E621E1F8-C36C-495A-93FC-0C247A3E6E5F",
    });
    expect(res.status).toBe(200);
    // Same value as the myapp vector but with another prefix: the hash must differ.
    const myapp = vectors.vectors.find((v) => v.prefix === "myapp-ban-v1" && v.kind === "idfv")!;
    expect(res.body.hash).not.toBe(myapp.hash);
    expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);

    const blocked = await check({ ids: { idfv: res.body.hash as string, install: "b".repeat(64) } });
    expect(blocked.body.status).toBe("blocked");
  });

  it("unban by hash deletes it; lookup confirms it", async () => {
    const hash = "c".repeat(64);
    await adminCall("POST", "/v1/admin/ban", { app: "demo", kind: "user", hash });
    expect((await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "user", hash })).body.banned).not.toBeNull();

    const res = await adminCall("POST", "/v1/admin/unban", { app: "demo", kind: "user", hash });
    expect(res.body).toMatchObject({ removed: true });
    expect((await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "user", hash })).body.banned).toBeNull();
  });

  it.each([
    ["invalid kind", { app: "demo", kind: "ip", value: "1.2.3.4" }],
    ["invalid ref", { app: "demo", ref: "abc" }],
    ["nothing to unban", { app: "demo" }],
  ])("400 on unban: %s", async (_name, payload) => {
    expect((await adminCall("POST", "/v1/admin/unban", payload)).status).toBe(400);
  });

  it("unknown route: 404", async () => {
    expect((await adminCall("GET", "/v1/admin/nope")).status).toBe(404);
  });
});

const TOKEN = "test-admin-token";

/** Admin request with a hand-built body and headers (broken JSON, other authorization schemes). */
async function rawAdmin(path: string, init: RequestInit, env: GuardEnv = guardEnv) {
  const res = await handle(new Request(`https://guard.test${path}`, init), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("admin: authorization", () => {
  it("Worker without ADMIN_TOKEN: rejects even an empty Bearer", async () => {
    const env = { ...guardEnv, ADMIN_TOKEN: undefined } as GuardEnv;
    const res = await rawAdmin("/v1/admin/lookup?app=demo&ref=AAAAAAAA", { headers: { authorization: "Bearer " } }, env);
    expect(res).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("the token with a scheme other than Bearer: 401", async () => {
    const res = await rawAdmin("/v1/admin/lookup?app=demo&ref=AAAAAAAA", {
      headers: { authorization: `Basic: ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("the right token with Bearer: authorized", async () => {
    const res = await rawAdmin("/v1/admin/lookup?app=demo&ref=AAAAAAAA", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

const A_HASH = "aa11deb247b5206df2d97ed0634cb04ae5d66d1f36616b3a683be06912b8848b";

describe("admin: validation (400 with the reason)", () => {
  const post = (path: string, body: string) =>
    rawAdmin(path, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });

  it.each(["/v1/admin/ban", "/v1/admin/unban"])("%s with broken JSON: invalid app", async (path) => {
    expect(await post(path, "{")).toEqual({ status: 400, body: { error: "invalid app" } });
  });

  it.each([
    ["ban", { app: "Demo!", kind: "idfv", value: "x" }, "invalid app"],
    ["ban", { app: "demo", kind: "idfv" }, "missing value or hash"],
    ["ban", { app: "demo", kind: "ip", value: "1.2.3.4" }, "invalid kind"],
    ["ban", { app: "demo", kind: "idfv", hash: "ABC" }, "invalid hash"],
    ["ban", { app: "demo", kind: "idfv", value: "" }, "invalid value"],
    ["ban", { app: "demo", kind: "idfv", value: 123 }, "invalid value"],
    ["ban", { app: "nope", kind: "idfv", value: "x" }, "app not configured"],
    // A hash pasted as the value would be hashed again and match nothing.
    ["ban", { app: "demo", kind: "icloud", value: A_HASH }, "value is a hash"],
    ["ban", { app: "demo", kind: "idfv", value: A_HASH }, "value is a hash"],
    ["ban", { app: "demo", kind: "install", value: ` ${A_HASH.toUpperCase()}\n` }, "value is a hash"],
    ["unban", { app: "demo", kind: "icloud", value: A_HASH }, "value is a hash"],
    ["unban", { app: "Demo!", ref: "A1B2C3D4" }, "invalid app"],
    ["unban", { app: "demo", ref: "a1b2c3d4" }, "invalid ref"],
    ["unban", { app: "demo" }, "missing value, hash or ref"],
    ["unban", { app: "demo", kind: "ip", value: "x" }, "invalid kind"],
  ])("%s %j: %s", async (op, payload, error) => {
    expect(await adminCall("POST", `/v1/admin/${op}`, payload)).toEqual({ status: 400, body: { error } });
  });

  it.each([
    [{ app: "Demo!", ref: "A1B2C3D4" }, "invalid app"],
    [{ app: "demo", ref: "a1b2c3d4" }, "invalid ref"],
    [{ app: "demo" }, "missing ref, value or hash"],
    [{ app: "demo", kind: "ip", value: "x" }, "invalid kind"],
    [{ app: "demo", kind: "icloud", value: A_HASH }, "value is a hash"],
  ])("lookup %j: %s", async (payload, error) => {
    expect(await adminCall("GET", "/v1/admin/lookup", payload)).toEqual({ status: 400, body: { error } });
  });
});

describe("admin: responses", () => {
  // A user ID is the app's own and may have the shape of a hash: it is hashed like any other.
  it("ban accepts a user value that looks like a hash", async () => {
    const value = randomHash();
    const res = await adminCall("POST", "/v1/admin/ban", { app: "demo", kind: "user", value });
    expect(res.status).toBe(200);
    expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.hash).not.toBe(value);
  });

  it("ban stores the note truncated to 500 characters", async () => {
    const hash = randomHash();
    await adminCall("POST", "/v1/admin/ban", { app: "demo", kind: "user", hash, note: "n".repeat(600) });
    const res = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "user", hash });
    expect((res.body.banned as { note: string }).note).toBe("n".repeat(500));
  });

  it("unban by ref: confirms app, ref and that it was scheduled", async () => {
    const res = await adminCall("POST", "/v1/admin/unban", { app: "demo", ref: "B1B2C3D4" });
    expect(res).toEqual({ status: 200, body: { app: "demo", ref: "B1B2C3D4", unban_scheduled: true } });
  });

  it("unban of a hash that was not there: removed false", async () => {
    const hash = randomHash();
    const res = await adminCall("POST", "/v1/admin/unban", { app: "demo", kind: "idfv", hash });
    expect(res.body).toEqual({ app: "demo", hash, removed: false });
  });
});

// A typo in `app` must not return a 200 that does nothing: each deployment's Worker only knows
// its configured apps (HASH_PREFIX_<APP>), also when `hash` or `ref` is sent.
describe("admin: app not configured (typo in app)", () => {
  const rows = async (table: "banned_ids" | "unban_refs", app: string) =>
    (await guardEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app = ?`).bind(app).first<{ n: number }>())!.n;

  it.each([
    ["POST", "ban", { kind: "idfv", hash: "d".repeat(64) }],
    ["POST", "unban", { ref: "A1B2C3D4" }],
    ["POST", "unban", { kind: "idfv", hash: "d".repeat(64) }],
    ["GET", "lookup", { ref: "A1B2C3D4" }],
    ["GET", "lookup", { kind: "idfv", hash: "d".repeat(64) }],
  ] as const)("%s %s %j: 400 and nothing in D1", async (method, op, payload) => {
    const res = await adminCall(method, `/v1/admin/${op}`, { app: "kits", ...payload });
    expect(res).toEqual({ status: 400, body: { error: "app not configured" } });
    expect(await rows("banned_ids", "kits")).toBe(0);
    expect(await rows("unban_refs", "kits")).toBe(0);
  });

  it("a malformed app is still 'invalid app', before 'not configured'", async () => {
    const res = await adminCall("POST", "/v1/admin/unban", { app: "Kits!", ref: "A1B2C3D4" });
    expect(res).toEqual({ status: 400, body: { error: "invalid app" } });
  });

  it("an app configured in observation mode does accept hash and ref", async () => {
    const hash = randomHash();
    expect((await adminCall("POST", "/v1/admin/ban", { app: "other", kind: "idfv", hash })).status).toBe(200);
    expect((await adminCall("POST", "/v1/admin/unban", { app: "other", ref: "C1B2C3D4" })).status).toBe(200);
  });
});
