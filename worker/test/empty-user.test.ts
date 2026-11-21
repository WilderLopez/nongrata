// An empty user ID (docs/CHECK-API.md): the hash of "" is the same for everyone, so a device that
// carried it and got banned would block every signed-out device. The check drops it.

import { describe, expect, it } from "vitest";
import { hashId, refFromInstallHash } from "../src/hash";
import { adminCall, check, guardEnv, randomHash, randomIds } from "./helpers";

const emptyUser = (prefix: string) => hashId(prefix, "user", "");

const ban = (app: string, body: Record<string, string>) => adminCall("POST", "/v1/admin/ban", { app, note: "test", ...body });

describe("an empty user in the check", () => {
  it("is not propagated by a blocked device, so other signed-out devices stay in", async () => {
    const user = await emptyUser(guardEnv.HASH_PREFIX_DEMO as string);
    const banned = { ...randomIds(), user };
    await ban("demo", { kind: "install", hash: banned.install });

    expect((await check({ ids: banned })).body.status).toBe("blocked");
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "user", hash: user });
    expect(row.body.banned).toBeNull();

    expect((await check({ ids: { ...randomIds(), user } })).body.status).toBe("ok");
    expect((await check({ platform: "android", ids: { install: randomHash(), user } })).body.status).toBe("ok");
  });

  it("does not match a ban of that hash", async () => {
    const user = await emptyUser(guardEnv.HASH_PREFIX_DEMO as string);
    await ban("demo", { kind: "user", hash: user });
    expect((await check({ ids: { ...randomIds(), user } })).body.status).toBe("ok");
  });

  it("is not linked to the device", async () => {
    const user = await emptyUser("linked-ban-v1");
    const ids = { ...randomIds(), user };
    expect((await check({ app: "linked", ids })).body.status).toBe("ok");
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "linked", ref: refFromInstallHash(ids.install) });
    expect(lookup.body.users).toEqual([]);
  });

  it("is per app: another app's empty-user hash is an ordinary hash here", async () => {
    const foreign = await emptyUser("other-ban-v1");
    await ban("demo", { kind: "user", hash: foreign });
    expect((await check({ ids: { ...randomIds(), user: foreign } })).body.status).toBe("blocked");
  });

  it("only the user kind is dropped: the same hash sent as idfv still counts", async () => {
    const hash = await emptyUser(guardEnv.HASH_PREFIX_DEMO as string);
    await ban("demo", { kind: "idfv", hash });
    expect((await check({ ids: { ...randomIds(), idfv: hash } })).body.status).toBe("blocked");
  });

  it("a real user next to it still counts", async () => {
    const user = randomHash();
    await ban("demo", { kind: "user", hash: user });
    expect((await check({ ids: { ...randomIds(), user } })).body.status).toBe("blocked");
  });
});

describe("admin: a value that is empty once normalized", () => {
  it.each([
    ["user", "   "],
    ["user", "\t\n"],
    ["install", " \r\n"],
    ["android_id", "  "],
  ])("ban %s %j: invalid value", async (kind, value) => {
    expect(await ban("demo", { kind, value })).toEqual({ status: 400, body: { error: "invalid value" } });
  });
});
