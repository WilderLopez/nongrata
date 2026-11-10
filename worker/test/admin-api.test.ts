// Listings of the admin API: GET /v1/admin/bans, /checks and /log (docs/ADMIN-API.md).
// D1 is shared between tests, so every test works on its own freshly configured app.

import { describe, expect, it } from "vitest";
import type { GuardEnv } from "../src/env";
import worker, { handle } from "../src/index";
import { guardEnv, randomHash, randomIds } from "./helpers";

const TOKEN = "test-admin-token";
const DAY_MS = 24 * 3600 * 1000;

type Body = Record<string, unknown>;
type Items<T = Body> = { app: string; items: T[]; next_cursor: string | null };

/** An app configured only in this test's env (HASH_PREFIX_<APP>), with nothing in D1. */
function freshApp() {
  const app = `t${randomHash().slice(0, 12)}`;
  const suffix = app.toUpperCase();
  const env = { ...guardEnv, [`HASH_PREFIX_${suffix}`]: `${app}-ban-v1`, [`ENFORCE_${suffix}`]: "true" } as GuardEnv;

  /** POST /v1/device/check for this app, without Apple and from a random IP (rate limit). */
  async function deviceCheck(body: Body) {
    const res = await handle(
      new Request("https://guard.test/v1/device/check", {
        method: "POST",
        headers: { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify({ app, platform: "ios", app_version: "1.0.0", ...body }),
      }),
      env,
      () => null,
    );
    return (await res.json()) as Body;
  }

  async function call(method: "GET" | "POST", path: string, params: Body = {}, token: string | null = TOKEN) {
    const url = new URL(`https://guard.test${path}`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (method === "GET") for (const [k, v] of Object.entries({ app, ...params })) url.searchParams.set(k, String(v));
    const body = method === "POST" ? JSON.stringify({ app, ...params }) : undefined;
    const res = await handle(new Request(url, { method, headers, body }), env);
    return { status: res.status, body: (await res.json()) as Body };
  }
  const get = async <T = Body>(path: string, params: Body = {}) => {
    const res = await call("GET", path, params);
    return res as { status: number; body: Items<T> & Body };
  };

  /** Follows next_cursor until the last page; returns the pages. */
  async function allPages<T>(path: string, params: Body): Promise<Items<T>[]> {
    const pages: Items<T>[] = [];
    let cursor: string | null = null;
    do {
      const query: Body = cursor === null ? params : { ...params, cursor };
      const res = await get<T>(path, query);
      expect(res.status).toBe(200);
      pages.push(res.body);
      cursor = res.body.next_cursor;
    } while (cursor !== null && pages.length < 20);
    return pages;
  }

  return { app, call, get, allPages, deviceCheck };
}

interface Ban {
  hash: string;
  kind: string;
  reason: string;
  note: string | null;
  created_at: number;
}

async function insertBans(app: string, rows: Ban[]) {
  const stmt = guardEnv.DB.prepare(
    "INSERT INTO banned_ids (app, hash, kind, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  await guardEnv.DB.batch(rows.map((r) => stmt.bind(app, r.hash, r.kind, r.reason, r.note, r.created_at)));
}

const ban = (created_at: number, extra: Partial<Ban> = {}): Ban => ({
  hash: randomHash(),
  kind: "idfv",
  reason: "manual",
  note: null,
  created_at,
  ...extra,
});

/** Newest first; same created_at, higher hash first. */
const newestFirst = (rows: Ban[]) =>
  [...rows].sort((a, b) => b.created_at - a.created_at || (a.hash < b.hash ? 1 : -1));

interface Check {
  ref: string;
  blocked: number;
  matched: number;
  bit0: number | null;
  intent: string | null;
  created_at: number;
}

/** Inserted in order: for equal created_at, the later row (higher rowid) comes first. */
async function insertChecks(app: string, rows: Check[]) {
  const stmt = guardEnv.DB.prepare(
    "INSERT INTO check_log (app, ref, blocked, matched, bit0, intent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await guardEnv.DB.batch(
    rows.map((r) => stmt.bind(app, r.ref, r.blocked, r.matched, r.bit0, r.intent, r.created_at)),
  );
}

const randomRef = () => randomHash().slice(0, 8).toUpperCase();

const checkRow = (created_at: number, extra: Partial<Check> = {}): Check => ({
  ref: randomRef(),
  blocked: 0,
  matched: 0,
  bit0: null,
  intent: "launch",
  created_at,
  ...extra,
});

const b64 = (text: string) => btoa(text).replace(/=+$/, "");

describe("admin listings: authorization and app", () => {
  it.each(["/v1/admin/bans", "/v1/admin/checks", "/v1/admin/log"])("%s without a valid token: 401", async (path) => {
    const { call } = freshApp();
    expect(await call("GET", path, {}, null)).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await call("GET", path, {}, "nope")).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it.each(["/v1/admin/bans", "/v1/admin/checks", "/v1/admin/log"])("%s with POST: 404", async (path) => {
    const { call } = freshApp();
    expect(await call("POST", path)).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it.each([
    ["/v1/admin/bans", { app: "Demo!" }, "invalid app"],
    ["/v1/admin/bans", { app: "kits" }, "app not configured"],
    ["/v1/admin/checks", { app: "Demo!" }, "invalid app"],
    ["/v1/admin/checks", { app: "kits" }, "app not configured"],
    ["/v1/admin/log", { app: "Demo!" }, "invalid app"],
    ["/v1/admin/log", { app: "kits" }, "app not configured"],
  ])("%s %j: 400 %s", async (path, params, error) => {
    const { get } = freshApp();
    expect(await get(path, params)).toEqual({ status: 400, body: { error } });
  });

  it.each(["/v1/admin/bans", "/v1/admin/checks", "/v1/admin/log"])("%s without app: invalid app", async (path) => {
    const res = await handle(
      new Request(`https://guard.test${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      guardEnv,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid app" });
  });

  it.each(["/v1/admin/bans", "/v1/admin/checks", "/v1/admin/log"])("%s of an empty app", async (path) => {
    const { app, get } = freshApp();
    expect(await get(path)).toEqual({ status: 200, body: { app, items: [], next_cursor: null } });
  });
});

describe("admin listings: limit and cursor (common to all three)", () => {
  const hash = "a".repeat(64);
  it.each([
    ...["/v1/admin/bans", "/v1/admin/checks", "/v1/admin/log"].flatMap((path) => [
      [path, { limit: "0" }, "invalid limit"],
      [path, { limit: "101" }, "invalid limit"],
      [path, { limit: "-1" }, "invalid limit"],
      [path, { limit: "1.5" }, "invalid limit"],
      [path, { limit: "1e1" }, "invalid limit"],
      [path, { limit: "x10" }, "invalid limit"],
      [path, { limit: "10x" }, "invalid limit"],
      [path, { limit: "" }, "invalid limit"],
      [path, { limit: "99999999999999999999" }, "invalid limit"],
      [path, { cursor: "" }, "invalid cursor"],
      [path, { cursor: "!!!" }, "invalid cursor"],
      [path, { cursor: b64("abc") }, "invalid cursor"],
      [path, { cursor: b64(`.${hash}`) }, "invalid cursor"],
      [path, { cursor: b64(`x1.${hash}`) }, "invalid cursor"],
      [path, { cursor: b64(`1x.${hash}`) }, "invalid cursor"],
      [path, { cursor: b64("99999999999999999999.1") }, "invalid cursor"],
      [path, { cursor: b64("1.2.3") }, "invalid cursor"],
    ]),
    // Each listing only accepts its own kind of key: a hash for bans, a row id for the others.
    ["/v1/admin/bans", { cursor: b64("1.2") }, "invalid cursor"],
    ["/v1/admin/bans", { cursor: b64(`1.${hash.toUpperCase()}`) }, "invalid cursor"],
    ["/v1/admin/checks", { cursor: b64(`1.${hash}`) }, "invalid cursor"],
    ["/v1/admin/log", { cursor: b64(`1.${hash}`) }, "invalid cursor"],
    ["/v1/admin/log", { cursor: b64("1.x2") }, "invalid cursor"],
  ] as [string, Body, string][])("%s %j: 400 %s", async (path, params, error) => {
    const { get } = freshApp();
    expect(await get(path, params)).toEqual({ status: 400, body: { error } });
  });

  it.each([
    // 67 and 4 characters: btoa pads them, b64 does not.
    ["/v1/admin/bans", b64(`12.${hash}`)],
    ["/v1/admin/checks", b64("1.23")],
    ["/v1/admin/log", b64("1.23")],
  ])("%s accepts a well-formed cursor, with or without padding", async (path, cursor) => {
    const { get } = freshApp();
    expect((await get(path, { cursor })).status).toBe(200);
    expect(btoa(atob(cursor))).toMatch(/=$/);
    expect((await get(path, { cursor: btoa(atob(cursor)) })).status).toBe(200);
  });
});

describe("GET /v1/admin/bans", () => {
  it("items with hash, kind, reason, note and created_at, newest first", async () => {
    const { app, get } = freshApp();
    const rows = [
      ban(1000, { kind: "icloud", reason: "propagated" }),
      ban(3000, { note: "spam" }),
      ban(2000, { kind: "user" }),
    ];
    await insertBans(app, rows);
    const res = await get("/v1/admin/bans");
    expect(res).toEqual({ status: 200, body: { app, items: newestFirst(rows), next_cursor: null } });
  });

  it("pages of `limit` that add up to the whole list, ties broken by hash", async () => {
    const { app, allPages } = freshApp();
    // Several rows with the same created_at, so the cursor has to tell them apart by hash.
    const rows = [ban(5000), ban(5000), ban(5000), ban(4000), ban(6000), ban(5000), ban(4000)];
    await insertBans(app, rows);
    const pages = await allPages<Ban>("/v1/admin/bans", { limit: 2 });
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 2, 1]);
    expect(pages.flatMap((p) => p.items)).toEqual(newestFirst(rows));
    expect(pages.every((p) => p.app === app)).toBe(true);
  });

  it("the cursor is base64url of created_at and hash of the last item", async () => {
    const { app, get } = freshApp();
    const hash = `ff${"0".repeat(62)}`;
    await insertBans(app, [ban(10, { hash }), ban(9)]);
    const first = await get("/v1/admin/bans", { limit: 1 });
    expect(first.body.next_cursor).toBe(
      "MTAuZmYwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMA",
    );
    const second = await get<Ban>("/v1/admin/bans", { limit: 1, cursor: first.body.next_cursor });
    expect(second.body.items.map((i) => i.created_at)).toEqual([9]);
    expect(second.body.next_cursor).toBeNull();
  });

  it("a full last page has no next_cursor", async () => {
    const { app, get } = freshApp();
    await insertBans(app, [ban(1), ban(2), ban(3)]);
    const res = await get("/v1/admin/bans", { limit: 3 });
    expect(res.body.items).toHaveLength(3);
    expect(res.body.next_cursor).toBeNull();
  });

  it("50 by default, at most 100", async () => {
    const { app, get } = freshApp();
    const rows = Array.from({ length: 101 }, (_, i) => ban(10_000 + i));
    await insertBans(app, rows);
    const sorted = newestFirst(rows);

    const byDefault = await get<Ban>("/v1/admin/bans");
    expect(byDefault.body.items).toEqual(sorted.slice(0, 50));
    expect(byDefault.body.next_cursor).toBe(b64(`${sorted[49]!.created_at}.${sorted[49]!.hash}`));

    const max = await get<Ban>("/v1/admin/bans", { limit: 100 });
    expect(max.body.items).toEqual(sorted.slice(0, 100));
    const rest = await get<Ban>("/v1/admin/bans", { limit: 100, cursor: max.body.next_cursor });
    expect(rest.body).toEqual({ app, items: sorted.slice(100), next_cursor: null });

    const one = await get<Ban>("/v1/admin/bans", { limit: 1 });
    expect(one.body.items).toEqual(sorted.slice(0, 1));
  });

  it("filters by kind and by reason, also together and across pages", async () => {
    const { app, get, allPages } = freshApp();
    const rows = [
      ban(1, { kind: "idfv", reason: "manual" }),
      ban(2, { kind: "icloud", reason: "propagated" }),
      ban(3, { kind: "icloud", reason: "manual" }),
      ban(4, { kind: "install", reason: "propagated" }),
      ban(5, { kind: "icloud", reason: "propagated" }),
    ];
    await insertBans(app, rows);
    const times = async (params: Body) => (await get<Ban>("/v1/admin/bans", params)).body.items.map((i) => i.created_at);
    expect(await times({ kind: "icloud" })).toEqual([5, 3, 2]);
    expect(await times({ reason: "manual" })).toEqual([3, 1]);
    expect(await times({ reason: "propagated" })).toEqual([5, 4, 2]);
    expect(await times({ kind: "icloud", reason: "propagated" })).toEqual([5, 2]);
    expect(await times({ kind: "user" })).toEqual([]);
    const pages = await allPages<Ban>("/v1/admin/bans", { kind: "icloud", limit: 1 });
    expect(pages.map((p) => p.items.map((i) => i.created_at))).toEqual([[5], [3], [2]]);
  });

  it("only lists its own app", async () => {
    const a = freshApp();
    const b = freshApp();
    await insertBans(a.app, [ban(1)]);
    expect((await b.get("/v1/admin/bans")).body.items).toEqual([]);
  });

  it.each([
    [{ kind: "ip" }, "invalid kind"],
    [{ kind: "" }, "invalid kind"],
    [{ reason: "auto" }, "invalid reason"],
    [{ reason: "" }, "invalid reason"],
  ])("%j: 400 %s", async (params, error) => {
    const { get } = freshApp();
    expect(await get("/v1/admin/bans", params)).toEqual({ status: 400, body: { error } });
  });

  it("lists what ban and propagation stored", async () => {
    const { call, get, deviceCheck } = freshApp();
    await call("POST", "/v1/admin/ban", { kind: "user", value: "u-1", note: "spam" });
    const ids = randomIds();
    // A device that carries the banned user is blocked and its other hashes propagate.
    const banned = (await get<Ban>("/v1/admin/bans")).body.items[0]!;
    expect(await deviceCheck({ ids: { ...ids, user: banned.hash } })).toMatchObject({ status: "blocked" });

    const items = (await get<Ban>("/v1/admin/bans")).body.items;
    expect(items.find((i) => i.reason === "manual")).toMatchObject({ kind: "user", note: "spam" });
    expect(items.filter((i) => i.reason === "propagated").map((i) => i.hash).sort()).toEqual(
      [ids.idfv, ids.install, ids.icloud].sort(),
    );
  });
});

describe("GET /v1/admin/checks", () => {
  it("items with ref, blocked, matched, bit0, intent and created_at, newest first", async () => {
    const { app, get } = freshApp();
    const rows = [
      checkRow(1000, { blocked: 1, matched: 1, bit0: 1, intent: "signup" }),
      checkRow(3000, { intent: null }),
      checkRow(2000, { bit0: 0 }),
    ];
    await insertChecks(app, rows);
    const res = await get("/v1/admin/checks");
    expect(res).toEqual({ status: 200, body: { app, items: [rows[1], rows[2], rows[0]], next_cursor: null } });
  });

  it("pages that add up to the whole log; same created_at, the later row first", async () => {
    const { app, allPages } = freshApp();
    const rows = [checkRow(7), checkRow(7), checkRow(8), checkRow(7), checkRow(6)];
    await insertChecks(app, rows);
    const pages = await allPages<Check>("/v1/admin/checks", { limit: 2 });
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((p) => p.items)).toEqual([rows[2], rows[3], rows[1], rows[0], rows[4]]);
  });

  it("filters by ref, blocked and since (inclusive), also together", async () => {
    const { app, get } = freshApp();
    const ref = randomRef();
    await insertChecks(app, [
      checkRow(100, { ref, blocked: 1, intent: "a" }),
      checkRow(200, { ref, intent: "b" }),
      checkRow(300, { blocked: 1, intent: "c" }),
      checkRow(400, { ref, blocked: 1, intent: "d" }),
      checkRow(500, { intent: "e" }),
    ]);
    const intents = async (params: Body) =>
      (await get<Check>("/v1/admin/checks", params)).body.items.map((i) => i.intent).join("");
    expect(await intents({})).toBe("edcba");
    expect(await intents({ ref })).toBe("dba");
    expect(await intents({ blocked: "1" })).toBe("dca");
    expect(await intents({ blocked: "0" })).toBe("eb");
    expect(await intents({ since: "300" })).toBe("edc");
    expect(await intents({ since: "301" })).toBe("ed");
    expect(await intents({ since: "0" })).toBe("edcba");
    expect(await intents({ ref, blocked: "1", since: "200" })).toBe("d");
    expect(await intents({ ref, blocked: "1", limit: "1", cursor: b64("400.999999999") })).toBe("d");
  });

  it("lists the checks the Worker logged, without identifiers", async () => {
    const { get, deviceCheck } = freshApp();
    const { ref } = await deviceCheck({ intent: "login", ids: randomIds() });
    const items = (await get<Check>("/v1/admin/checks")).body.items;
    expect(items).toEqual([
      { ref, blocked: 0, matched: 0, bit0: null, intent: "login", created_at: expect.any(Number) },
    ]);
  });

  it.each([
    [{ ref: "a1b2c3d4" }, "invalid ref"],
    [{ ref: "" }, "invalid ref"],
    [{ blocked: "2" }, "invalid blocked"],
    [{ blocked: "true" }, "invalid blocked"],
    [{ blocked: "" }, "invalid blocked"],
    [{ since: "" }, "invalid since"],
    [{ since: "-1" }, "invalid since"],
    [{ since: "yesterday" }, "invalid since"],
    [{ since: "99999999999999999999" }, "invalid since"],
  ])("%j: 400 %s", async (params, error) => {
    const { get } = freshApp();
    expect(await get("/v1/admin/checks", params)).toEqual({ status: 400, body: { error } });
  });
});

interface LogItem {
  action: string;
  kind: string | null;
  hash: string | null;
  ref: string | null;
  note: string | null;
  created_at: number;
}

describe("GET /v1/admin/log", () => {
  it("records every successful ban and unban, newest first", async () => {
    const { call, get } = freshApp();
    const hash = randomHash();
    const before = Date.now();
    const banned = await call("POST", "/v1/admin/ban", { kind: "idfv", value: "E621E1F8-C36C", note: "spam" });
    await call("POST", "/v1/admin/ban", { kind: "user", hash });
    await call("POST", "/v1/admin/unban", { kind: "user", hash });
    await call("POST", "/v1/admin/unban", { ref: "A1B2C3D4" });
    await call("POST", "/v1/admin/unban", { kind: "icloud", hash, ref: "B1B2C3D4" });

    const res = await get<LogItem>("/v1/admin/log");
    expect(res.body.next_cursor).toBeNull();
    expect(res.body.items).toEqual([
      { action: "unban", kind: "icloud", hash, ref: "B1B2C3D4", note: null, created_at: expect.any(Number) },
      { action: "unban", kind: null, hash: null, ref: "A1B2C3D4", note: null, created_at: expect.any(Number) },
      { action: "unban", kind: "user", hash, ref: null, note: null, created_at: expect.any(Number) },
      { action: "ban", kind: "user", hash, ref: null, note: null, created_at: expect.any(Number) },
      { action: "ban", kind: "idfv", hash: banned.body.hash, ref: null, note: "spam", created_at: expect.any(Number) },
    ]);
    for (const item of res.body.items) expect(item.created_at).toBeGreaterThanOrEqual(before);
  });

  it("a ban by value stores only the hash, never the value", async () => {
    const { app, call } = freshApp();
    const value = `RAW-${randomHash()}`;
    await call("POST", "/v1/admin/ban", { kind: "user", value });
    const { results } = await guardEnv.DB.prepare("SELECT * FROM admin_log WHERE app = ?").bind(app).all();
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(value);
  });

  it("the note is truncated to 500 characters, like the ban's", async () => {
    const { call, get } = freshApp();
    await call("POST", "/v1/admin/ban", { kind: "user", hash: randomHash(), note: "n".repeat(600) });
    expect((await get<LogItem>("/v1/admin/log")).body.items[0]!.note).toBe("n".repeat(500));
  });

  it("an unban of a hash that was not listed is still recorded", async () => {
    const { call, get } = freshApp();
    const hash = randomHash();
    expect((await call("POST", "/v1/admin/unban", { kind: "idfv", hash })).body).toMatchObject({ removed: false });
    expect((await get<LogItem>("/v1/admin/log")).body.items).toMatchObject([{ action: "unban", hash }]);
  });

  it("a rejected request is not recorded", async () => {
    const { call, get } = freshApp();
    expect((await call("POST", "/v1/admin/ban", { kind: "ip", value: "1.2.3.4" })).status).toBe(400);
    expect((await call("POST", "/v1/admin/unban", { ref: "abc" })).status).toBe(400);
    expect((await call("POST", "/v1/admin/ban", { kind: "idfv", hash: randomHash() }, "nope")).status).toBe(401);
    expect((await get("/v1/admin/log")).body.items).toEqual([]);
  });

  it("pages, with ties on created_at broken by id", async () => {
    const { app, allPages } = freshApp();
    const insert = guardEnv.DB.prepare(
      "INSERT INTO admin_log (app, action, kind, hash, ref, note, created_at) VALUES (?, 'unban', NULL, NULL, ?, NULL, ?)",
    );
    const refs = ["A0000000", "A0000001", "A0000002", "A0000003", "A0000004"];
    await guardEnv.DB.batch([
      insert.bind(app, refs[0], 50),
      insert.bind(app, refs[1], 60),
      insert.bind(app, refs[2], 50),
      insert.bind(app, refs[3], 50),
      insert.bind(app, refs[4], 40),
    ]);
    const pages = await allPages<LogItem>("/v1/admin/log", { limit: 2 });
    expect(pages.map((p) => p.items.map((i) => i.ref))).toEqual([
      [refs[1], refs[3]],
      [refs[2], refs[0]],
      [refs[4]],
    ]);
  });

  it("only lists its own app", async () => {
    const a = freshApp();
    const b = freshApp();
    await a.call("POST", "/v1/admin/unban", { ref: "C1B2C3D4" });
    expect((await b.get("/v1/admin/log")).body.items).toEqual([]);
    expect((await a.get("/v1/admin/log")).body.items).toHaveLength(1);
  });

  it("the daily cron does not purge it", async () => {
    const { app, get } = freshApp();
    await guardEnv.DB.prepare(
      "INSERT INTO admin_log (app, action, kind, hash, ref, note, created_at) VALUES (?, 'unban', NULL, NULL, 'D1B2C3D4', NULL, ?)",
    )
      .bind(app, Date.now() - 400 * DAY_MS)
      .run();
    await worker.scheduled!({} as never, guardEnv);
    expect((await get<LogItem>("/v1/admin/log")).body.items).toMatchObject([{ ref: "D1B2C3D4" }]);
  });
});
