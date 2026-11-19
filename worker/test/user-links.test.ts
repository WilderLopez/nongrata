// The link between a user and the devices it was seen on (docs/DESIGN.md, section 6.5). Only for
// apps with LINK_USERS_<APP>: `linked` enforces, `linkedobs` is in observation mode.

import { describe, expect, it } from "vitest";
import { parseCheckRequest, runCheck } from "../src/check";
import { appConfig } from "../src/env";
import { refFromInstallHash } from "../src/hash";
import worker from "../src/index";
import { Store } from "../src/store";
import { adminCall, check, guardEnv, logRows, randomHash, randomIds } from "./helpers";

const DAY_MS = 24 * 3600 * 1000;
const APP = "linked";
const WATCH = "linkedobs";

const ban = (app: string, kind: string, hash: string) => adminCall("POST", "/v1/admin/ban", { app, kind, hash });

const lookup = async (app: string, params: Record<string, string>) =>
  (await adminCall("GET", "/v1/admin/lookup", { app, ...params })).body;

const links = async (app: string, install: string) =>
  (
    await guardEnv.DB.prepare(
      "SELECT user_hash, first_seen, last_seen FROM user_links WHERE app = ? AND install_hash = ? ORDER BY first_seen, user_hash",
    )
      .bind(app, install)
      .all<{ user_hash: string; first_seen: number; last_seen: number }>()
  ).results;

const insertLink = (app: string, install: string, user: string, firstSeen: number, lastSeen: number) =>
  guardEnv.DB.prepare("INSERT INTO user_links (app, install_hash, user_hash, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)").bind(
    app,
    install,
    user,
    firstSeen,
    lastSeen,
  );

const insertCheck = (app: string, ref: string, blocked: number, createdAt: number) =>
  guardEnv.DB.prepare(
    "INSERT INTO check_log (app, ref, blocked, matched, bit0, intent, created_at) VALUES (?, ?, ?, 0, NULL, 'launch', ?)",
  ).bind(app, ref, blocked, createdAt);

/** A check at a chosen time, without the HTTP layer. */
const checkAt = (ids: Record<string, string | null>, now: number, app = APP, db = guardEnv.DB) =>
  runCheck(parseCheckRequest({ app, ids })!, appConfig(guardEnv, app)!, {
    store: new Store(db),
    deviceCheck: null,
    now,
  });

/** The database of a Worker that has not applied migration 0005: any query on `user_links` fails. */
const withoutLinksTable = (db: D1Database): D1Database =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("user_links")) throw new Error("no such table: user_links");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

describe("user links: the check", () => {
  it("a ban by user reaches a device that carried that user, even signed out", async () => {
    const ids = randomIds();
    const user = randomHash();
    const ref = refFromInstallHash(ids.install);
    expect((await check({ app: APP, ids: { ...ids, user } })).body.status).toBe("ok");
    await ban(APP, "user", user);

    expect((await check({ app: APP, ids })).body).toEqual({ status: "blocked", ref });

    expect(await logRows(APP, ref)).toEqual([
      { blocked: 0, matched: 0, bit0: null, intent: "launch" },
      { blocked: 1, matched: 1, bit0: null, intent: "launch" },
    ]);
    // Blocked like any other device: its own identifiers are propagated with its ref.
    expect((await lookup(APP, { kind: "icloud", hash: ids.icloud })).banned).toMatchObject({ reason: "propagated" });
  });

  it("only the devices that carried the user, and only in that app", async () => {
    const [carrier, stranger] = [randomIds(), randomIds()];
    const user = randomHash();
    await check({ app: APP, ids: { ...carrier, user } });
    await ban(APP, "user", user);
    await ban(WATCH, "user", user);

    expect((await check({ app: APP, ids: stranger })).body.status).toBe("ok");
    // The same install in another app has no link there.
    await check({ app: WATCH, ids: carrier });
    expect(await logRows(WATCH, refFromInstallHash(carrier.install))).toEqual([
      { blocked: 0, matched: 0, bit0: null, intent: "launch" },
    ]);
  });

  it("without LINK_USERS_<APP>: stores no link, and ignores one that is there", async () => {
    const ids = randomIds();
    const [user, planted] = [randomHash(), randomHash()];
    await check({ ids: { ...ids, user } });
    expect(await links("demo", ids.install)).toEqual([]);

    await insertLink("demo", ids.install, planted, 1, 1).run();
    await ban("demo", "user", user);
    await ban("demo", "user", planted);
    expect((await check({ ids })).body.status).toBe("ok");
  });

  // The variable is what turns the feature on, so a Worker can deploy this code before 0005.
  it("without LINK_USERS_<APP>: no step of the check touches user_links, not even a full unban", async () => {
    const ids = { ...randomIds(), user: randomHash() };
    const ref = refFromInstallHash(ids.install);
    const db = withoutLinksTable(guardEnv.DB);
    const now = Date.now();
    await ban("demo", "idfv", ids.idfv);
    expect(await checkAt(ids, now, "demo", db)).toEqual({ status: "blocked", ref });

    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    expect(await checkAt(ids, Date.now(), "demo", db)).toEqual({ status: "ok", ref });
    expect((await lookup("demo", { ref })).unban).toMatchObject({ consumed_at: expect.any(Number) });

    // The same database does fail for an app that links users.
    await expect(checkAt(ids, now, APP, db)).rejects.toThrow("user_links");
  });

  it("observation mode: keeps the link and logs the match, without blocking or propagating", async () => {
    const ids = randomIds();
    const user = randomHash();
    await check({ app: WATCH, ids: { ...ids, user } });
    expect(await links(WATCH, ids.install)).toHaveLength(1);
    await ban(WATCH, "user", user);

    expect((await check({ app: WATCH, ids })).body.status).toBe("ok");

    expect(await logRows(WATCH, refFromInstallHash(ids.install))).toEqual([
      { blocked: 0, matched: 0, bit0: null, intent: "launch" },
      { blocked: 1, matched: 1, bit0: null, intent: "launch" },
    ]);
    expect((await lookup(WATCH, { kind: "icloud", hash: ids.icloud })).banned).toBeNull();
  });

  it("a check without a user stores no link; each user of a device gets its own", async () => {
    const ids = randomIds();
    const [first, second] = [randomHash(), randomHash()];
    const t0 = 1_800_000_000_000;
    await checkAt(ids, t0);
    expect(await links(APP, ids.install)).toEqual([]);

    await checkAt({ ...ids, user: first }, t0 + 1);
    await checkAt({ ...ids, user: second }, t0 + 2);
    expect(await links(APP, ids.install)).toEqual([
      { user_hash: first, first_seen: t0 + 1, last_seen: t0 + 1 },
      { user_hash: second, first_seen: t0 + 2, last_seen: t0 + 2 },
    ]);
  });

  it("the link is written once and refreshed only when it is more than a day old", async () => {
    const ids = { ...randomIds(), user: randomHash() };
    const t0 = 1_800_000_000_000;
    await checkAt(ids, t0);
    await checkAt(ids, t0 + DAY_MS);
    expect(await links(APP, ids.install)).toEqual([{ user_hash: ids.user, first_seen: t0, last_seen: t0 }]);

    await checkAt(ids, t0 + DAY_MS + 1);
    expect(await links(APP, ids.install)).toEqual([
      { user_hash: ids.user, first_seen: t0, last_seen: t0 + DAY_MS + 1 },
    ]);
  });

  it("the last decision wins through a link: a later ban of a linked user cancels the unban", async () => {
    const ids = randomIds();
    const user = randomHash();
    const ref = refFromInstallHash(ids.install);
    await check({ app: APP, ids: { ...ids, user } });
    await ban(APP, "install", ids.install);
    await adminCall("POST", "/v1/admin/unban", { app: APP, ref });
    // Date.now() only moves between I/O in workerd: make sure the new ban is strictly later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ban(APP, "user", user);

    expect((await check({ app: APP, ids })).body.status).toBe("blocked");
    expect((await lookup(APP, { ref })).unban).toBeNull();
  });

  it("a full unban by ref drops the device's link to the banned user, who stays banned", async () => {
    const ids = randomIds();
    const [banned, clean] = [randomHash(), randomHash()];
    const ref = refFromInstallHash(ids.install);
    await check({ app: APP, ids: { ...ids, user: banned } });
    await check({ app: APP, ids: { ...ids, user: clean } });
    await ban(APP, "user", banned);
    expect((await check({ app: APP, ids })).body.status).toBe("blocked");

    await adminCall("POST", "/v1/admin/unban", { app: APP, ref });

    expect((await check({ app: APP, ids })).body.status).toBe("ok");
    expect((await lookup(APP, { ref })).unban).toMatchObject({ consumed_at: expect.any(Number) });
    // Without the link, that user's ban no longer reaches this device.
    expect((await check({ app: APP, ids })).body.status).toBe("ok");
    expect((await lookup(APP, { kind: "user", hash: banned })).banned).toMatchObject({ reason: "manual" });
    expect((await links(APP, ids.install)).map((l) => l.user_hash)).toEqual([clean]);
  });

  it("stores only hashes in user_links", async () => {
    const { results } = await guardEnv.DB.prepare("PRAGMA table_info(user_links)").all<{ name: string }>();
    expect(results.map((c) => c.name).sort()).toEqual(["app", "first_seen", "install_hash", "last_seen", "user_hash"]);
  });
});

describe("user links: the store", () => {
  // The same guard as removeHashes: a ban that arrives between runCheck's look and the delete.
  it("unlinkBanned drops the links to users banned up to the unban, and to propagated ones", async () => {
    const store = new Store(guardEnv.DB);
    const [install, neighbour] = [randomHash(), randomHash()];
    const [older, newer, automatic, clean] = [randomHash(), randomHash(), randomHash(), randomHash()];
    await guardEnv.DB.batch([
      ...[older, newer, automatic, clean].map((user) => insertLink(APP, install, user, 1, 1)),
      insertLink(APP, neighbour, older, 1, 1),
      insertLink(WATCH, install, older, 1, 1),
    ]);
    await store.banManual(APP, { kind: "user", hash: older }, null, "token", 1000);
    await store.banManual(APP, { kind: "user", hash: newer }, null, "token", 3000);
    await store.insertPropagated(APP, "ABCDEF12", [{ kind: "user", hash: automatic }], 3000);

    await store.unlinkBanned(APP, install, 2000);

    expect((await links(APP, install)).map((l) => l.user_hash).sort()).toEqual([newer, clean].sort());
    expect(await links(APP, neighbour)).toHaveLength(1);
    expect(await links(WATCH, install)).toHaveLength(1);
  });

  it("unlinkBanned at the very time of the ban drops the link", async () => {
    const store = new Store(guardEnv.DB);
    const [install, user] = [randomHash(), randomHash()];
    await insertLink(APP, install, user, 1, 1).run();
    await store.banManual(APP, { kind: "user", hash: user }, null, "token", 2000);

    await store.unlinkBanned(APP, install, 2000);

    expect(await links(APP, install)).toEqual([]);
  });
});

describe("user links: purge cron", () => {
  it("deletes links not seen for 180 days, except those of a user banned in that app", async () => {
    const now = Date.now();
    const install = randomHash();
    const [old, edge, banned, bannedElsewhere] = [randomHash(), randomHash(), randomHash(), randomHash()];
    await guardEnv.DB.batch([
      insertLink(APP, install, old, 1, now - 181 * DAY_MS),
      insertLink(APP, install, edge, 1, now - 179 * DAY_MS),
      insertLink(APP, install, banned, 1, now - 181 * DAY_MS),
      insertLink(APP, install, bannedElsewhere, 1, now - 181 * DAY_MS),
    ]);
    await ban(APP, "user", banned);
    await ban(WATCH, "user", bannedElsewhere);

    await worker.scheduled!({} as never, guardEnv);

    expect((await links(APP, install)).map((l) => l.user_hash).sort()).toEqual([edge, banned].sort());
  });
});

describe("user links: lookup", () => {
  it("by user: its devices, most recently seen first, each with its last verdict", async () => {
    const user = randomHash();
    const [blocked, allowed, silent] = [randomHash(), randomHash(), randomHash()];
    const refOf = refFromInstallHash;
    await guardEnv.DB.batch([
      insertLink(APP, allowed, user, 100, 2000),
      insertLink(APP, blocked, user, 200, 3000),
      insertLink(APP, silent, user, 300, 1000),
      // Someone else's device, and the same user in another app.
      insertLink(APP, randomHash(), randomHash(), 1, 9000),
      insertLink(WATCH, randomHash(), user, 1, 9000),
      insertCheck(APP, refOf(blocked), 0, 10),
      insertCheck(APP, refOf(blocked), 1, 20),
      insertCheck(APP, refOf(allowed), 1, 10),
      insertCheck(APP, refOf(allowed), 0, 20),
      // Another app's check of that device does not count.
      insertCheck(WATCH, refOf(allowed), 1, 30),
    ]);

    expect(await lookup(APP, { kind: "user", hash: user })).toEqual({
      app: APP,
      hash: user,
      banned: null,
      devices: [
        { ref: refOf(blocked), install_hash: blocked, first_seen: 200, last_seen: 3000, blocked: 1 },
        { ref: refOf(allowed), install_hash: allowed, first_seen: 100, last_seen: 2000, blocked: 0 },
        { ref: refOf(silent), install_hash: silent, first_seen: 300, last_seen: 1000, blocked: null },
      ],
      devices_more: false,
    });
  });

  it("by user with no device seen: an empty list, not a missing field", async () => {
    expect(await lookup(APP, { kind: "user", hash: randomHash() })).toMatchObject({ devices: [], devices_more: false });
  });

  it("by an identifier of another kind: no devices field", async () => {
    const hash = randomHash();
    await insertLink(APP, randomHash(), hash, 1, 1).run();
    expect(await lookup(APP, { kind: "icloud", hash })).toEqual({ app: APP, hash, banned: null });
  });

  it("by user: at most 100 devices, and says whether there are more", async () => {
    const [full, over] = [randomHash(), randomHash()];
    await guardEnv.DB.batch([
      ...Array.from({ length: 100 }, (_, i) => insertLink(APP, randomHash(), full, 1, i)),
      ...Array.from({ length: 101 }, (_, i) => insertLink(APP, randomHash(), over, 1, i)),
    ]);

    const exact = await lookup(APP, { kind: "user", hash: full });
    expect((exact.devices as unknown[]).length).toBe(100);
    expect(exact.devices_more).toBe(false);

    const capped = await lookup(APP, { kind: "user", hash: over });
    const devices = capped.devices as { last_seen: number }[];
    expect(devices.length).toBe(100);
    expect(capped.devices_more).toBe(true);
    // The one left out is the least recently seen.
    expect(devices.at(-1)!.last_seen).toBe(1);
  });

  it("by ref: the users seen on that device, most recent first, and whether each is banned", async () => {
    const install = randomHash();
    const ref = refFromInstallHash(install);
    const [banned, clean, bannedElsewhere] = [randomHash(), randomHash(), randomHash()];
    await guardEnv.DB.batch([
      insertLink(APP, install, banned, 100, 1000),
      insertLink(APP, install, clean, 200, 3000),
      insertLink(APP, install, bannedElsewhere, 300, 2000),
      // Another device, and the same device in another app.
      insertLink(APP, randomHash(), randomHash(), 1, 9000),
      insertLink(WATCH, install, randomHash(), 1, 9000),
    ]);
    await ban(APP, "user", banned);
    await ban(WATCH, "user", bannedElsewhere);

    expect(await lookup(APP, { ref })).toEqual({
      app: APP,
      ref,
      unban: null,
      checks: [],
      users: [
        { hash: clean, first_seen: 200, last_seen: 3000, banned: 0 },
        { hash: bannedElsewhere, first_seen: 300, last_seen: 2000, banned: 0 },
        { hash: banned, first_seen: 100, last_seen: 1000, banned: 1 },
      ],
      users_more: false,
    });
  });

  it("by ref: at most 100 users, and says whether there are more", async () => {
    const [full, over] = [randomHash(), randomHash()];
    await guardEnv.DB.batch([
      ...Array.from({ length: 100 }, (_, i) => insertLink(APP, full, randomHash(), 1, i)),
      ...Array.from({ length: 101 }, (_, i) => insertLink(APP, over, randomHash(), 1, i)),
    ]);

    const exact = await lookup(APP, { ref: refFromInstallHash(full) });
    expect((exact.users as unknown[]).length).toBe(100);
    expect(exact.users_more).toBe(false);

    const capped = await lookup(APP, { ref: refFromInstallHash(over) });
    const users = capped.users as { last_seen: number }[];
    expect(users.length).toBe(100);
    expect(capped.users_more).toBe(true);
    expect(users.at(-1)!.last_seen).toBe(1);
  });

  it("an app without LINK_USERS_<APP>: neither field, even with links stored", async () => {
    const [install, user] = [randomHash(), randomHash()];
    await insertLink("demo", install, user, 1, 1).run();

    expect(await lookup("demo", { kind: "user", hash: user })).toEqual({ app: "demo", hash: user, banned: null });
    expect(await lookup("demo", { ref: refFromInstallHash(install) })).toEqual({
      app: "demo",
      ref: refFromInstallHash(install),
      unban: null,
      checks: [],
    });
  });
});
