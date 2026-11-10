// Pairing an admin device (docs/DEVICE-PAIRING.md, section 2): create, claim, status, approve,
// cancel, and the cron. D1 is shared between tests: every test makes its own pairings.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuardEnv } from "../src/env";
import worker, { handle } from "../src/index";
import {
  b64,
  claimBody,
  claimRaw,
  createPairing,
  deviceRow,
  expectedCode,
  hex,
  newKey,
  nonceCount,
  pairDevice,
  pairingRow,
  randomB64,
  send,
  setPairingExpiry,
  signText,
  tokenCall,
} from "./device-helpers";
import { guardEnv } from "./helpers";

const TEN_MIN = 10 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /v1/admin/pairings", () => {
  it("returns id, secret, role, expiry and the pair_url; D1 keeps only the secret's hash", async () => {
    const before = Date.now();
    const res = await tokenCall("POST", "/v1/admin/pairings", { role: "admin", label: "Ana's iPhone" });
    const after = Date.now();
    expect(res.status).toBe(200);
    const { id, secret, role, expires_at, pair_url } = res.body as Record<string, string & number>;
    expect(Object.keys(res.body).sort()).toEqual(["expires_at", "id", "pair_url", "role", "secret"]);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(role).toBe("admin");
    expect(expires_at).toBeGreaterThanOrEqual(before + TEN_MIN);
    expect(expires_at).toBeLessThanOrEqual(after + TEN_MIN);
    expect(pair_url).toBe(
      `nongrata://pair?v=1&url=https%3A%2F%2Fguard.test&id=${id}&secret=${secret}&role=admin&exp=${expires_at}`,
    );

    const row = await pairingRow(id);
    expect(row).toEqual({
      id,
      secret_hash: await hex(secret),
      role: "admin",
      label: "Ana's iPhone",
      created_at: expires_at - TEN_MIN,
      expires_at,
      failed_attempts: 0,
      claimed_at: null,
      device_id: null,
      approved_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("each pairing gets its own id and secret", async () => {
    const [a, b] = await Promise.all([createPairing("read"), createPairing("read")]);
    expect(a.id).not.toBe(b.id);
    expect(a.secret).not.toBe(b.secret);
    expect(a.role).toBe("read");
  });

  it("without a label, or with a null one, the label is null", async () => {
    expect((await pairingRow((await createPairing("read")).id))!.label).toBeNull();
    const res = await tokenCall("POST", "/v1/admin/pairings", { role: "read", label: null });
    expect((await pairingRow(res.body.id as string))!.label).toBeNull();
  });

  it("the label may have 64 UTF-16 code units", async () => {
    for (const label of ["x".repeat(64), "🙂".repeat(32)]) {
      const res = await tokenCall("POST", "/v1/admin/pairings", { role: "read", label });
      expect(res.status).toBe(200);
      expect((await pairingRow(res.body.id as string))!.label).toBe(label);
    }
  });

  it("the link must be https; http only towards localhost or 127.0.0.1, any port", async () => {
    for (const origin of ["http://localhost:8787", "http://127.0.0.1", "http://127.0.0.1:9000"]) {
      const res = await handle(
        new Request(`${origin}/v1/admin/pairings`, {
          method: "POST",
          headers: { authorization: "Bearer test-admin-token" },
          body: '{"role":"read"}',
        }),
        guardEnv,
      );
      const body = (await res.json()) as { pair_url: string };
      expect(res.status).toBe(200);
      expect(body.pair_url).toContain(`url=${encodeURIComponent(origin)}&`);
    }
    for (const origin of ["http://guard.test", "http://[::1]:8787", "http://localhost.example.com", "ftp://localhost"]) {
      const res = await handle(
        new Request(`${origin}/v1/admin/pairings`, {
          method: "POST",
          headers: { authorization: "Bearer test-admin-token" },
          body: '{"role":"read"}',
        }),
        guardEnv,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "https required" });
    }
  });

  it.each([
    [{}, "invalid role"],
    [{ role: "root" }, "invalid role"],
    [{ role: 1 }, "invalid role"],
    [{ role: "admin", label: "x".repeat(65) }, "invalid label"],
    [{ role: "admin", label: "🙂".repeat(32) + "x" }, "invalid label"],
    [{ role: "admin", label: "" }, "invalid label"],
    [{ role: "admin", label: 7 }, "invalid label"],
  ])("%j: 400 %s", async (payload, error) => {
    expect(await tokenCall("POST", "/v1/admin/pairings", payload)).toEqual({ status: 400, body: { error } });
  });

  it("a body that is not JSON: invalid role", async () => {
    const res = await send("POST", "/v1/admin/pairings", {
      headers: { authorization: "Bearer test-admin-token" },
      body: "nope",
    });
    expect(res).toEqual({ status: 400, body: { error: "invalid role" } });
  });

  it("without the token: 401", async () => {
    expect(await send("POST", "/v1/admin/pairings", { body: '{"role":"admin"}' })).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });
});

describe("POST /v1/pair/claim", () => {
  it("creates a pending device and answers device_id, role and the verification code", async () => {
    const pairing = await createPairing("read");
    const key = await newKey();
    const before = Date.now();
    const res = await claimRaw(await claimBody(pairing, key, { name: "Ana's iPad", platform: "ipados" }));
    expect(res.status).toBe(200);
    const deviceId = res.body.device_id as string;
    expect(res.body).toEqual({
      device_id: deviceId,
      role: "read",
      verification_code: await expectedCode(pairing.id, key.publicKey),
    });
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const device = await deviceRow(deviceId);
    expect(device).toEqual({
      id: deviceId,
      name: "Ana's iPad",
      platform: "ipados",
      role: "read",
      public_key: key.publicKey,
      status: "pending",
      created_at: expect.any(Number),
      last_used_at: null,
      revoked_at: null,
    });
    expect(device!.created_at).toBeGreaterThanOrEqual(before);
    const row = await pairingRow(pairing.id);
    expect(row).toMatchObject({ device_id: deviceId, claimed_at: device!.created_at, failed_attempts: 0 });
  });

  it.each(["ios", "ipados", "macos", "other"])("platform %s", async (platform) => {
    const pairing = await createPairing();
    expect((await claimRaw(await claimBody(pairing, await newKey(), { platform }))).status).toBe(200);
  });

  it("a name of 64 UTF-16 code units is accepted", async () => {
    for (const name of ["é".repeat(64), "🙂".repeat(32)]) {
      const pairing = await createPairing();
      expect((await claimRaw(await claimBody(pairing, await newKey(), { name }))).status).toBe(200);
    }
  });

  it.each([
    ["missing name", { name: undefined }, "invalid name"],
    ["empty name", { name: "" }, "invalid name"],
    ["name of 65 UTF-16 units", { name: "é".repeat(65) }, "invalid name"],
    ["name of 33 emoji", { name: "🙂".repeat(33) }, "invalid name"],
    ["name not a string", { name: ["x"] }, "invalid name"],
    ["unknown platform", { platform: "android" }, "invalid platform"],
    ["platform not a string", { platform: 1 }, "invalid platform"],
    // Checked before the secret and the pairing, so even a wrong secret gets this answer.
    ["bad name and wrong secret", { name: "", secret: "x" }, "invalid name"],
  ])("%s: 400 %s, named, and no attempt counted", async (_name, extra, error) => {
    const pairing = await createPairing();
    const res = await claimRaw({ ...(await claimBody(pairing, await newKey())), ...extra });
    expect(res).toEqual({ status: 400, body: { error } });
    expect((await pairingRow(pairing.id))!).toMatchObject({ failed_attempts: 0, claimed_at: null });
  });

  /** Claims with `change` applied; checks the 400 and that it counted as one failed attempt. */
  async function rejected(
    change: (b: Record<string, unknown>) => unknown | Promise<unknown>,
    setup?: (id: string) => Promise<void>,
  ) {
    const pairing = await createPairing();
    await setup?.(pairing.id);
    const before = (await pairingRow(pairing.id))!.failed_attempts as number;
    const body = await claimBody(pairing, await newKey());
    const res = await claimRaw((await change(body as Record<string, unknown>)) ?? body);
    expect(res).toEqual({ status: 400, body: { error: "invalid pairing" } });
    expect((await pairingRow(pairing.id))!.failed_attempts).toBe(before + 1);
    return pairing;
  }

  it("wrong secret", async () => {
    await rejected((b) => ({ ...b, secret: randomB64(32) }));
  });

  it.each([
    ["missing secret", { secret: undefined }],
    ["secret not a string", { secret: 5 }],
    ["missing public key", { public_key: undefined }],
    ["public key not a string", { public_key: 1 }],
    ["missing proof", { proof: undefined }],
    ["proof not a string", { proof: 1 }],
    ["proof of 63 bytes", { proof: randomB64(63) }],
  ])("%s", async (_name, extra) => {
    await rejected((b) => ({ ...b, ...extra }));
  });

  it("a public key of 64 bytes", async () => {
    await rejected((b) => ({ ...b, public_key: (b.public_key as string).slice(0, -1) }));
  });

  it("a public key of 65 bytes that is not an uncompressed point (0x03 instead of 0x04)", async () => {
    const key = await newKey();
    const bytes = Uint8Array.from(atob(key.publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    bytes[0] = 3;
    const tagged = b64(bytes);
    await rejected(async (b) => ({
      ...b,
      public_key: tagged,
      proof: await signText(key.privateKey, `NONGRATA-PAIR-V1\n${b.id}\n${tagged}`),
    }));
  });

  it("a bad proof: over another pairing id, or made with another key", async () => {
    const key = await newKey();
    await rejected(async (b) => ({
      ...b,
      proof: await signText(key.privateKey, `NONGRATA-PAIR-V1\n${randomB64(16)}\n${b.public_key}`),
    }));
    // The proof is right for `key`, but the public key sent is another one.
    await rejected(async (b) => ({
      ...b,
      proof: await signText(key.privateKey, `NONGRATA-PAIR-V1\n${b.id}\n${b.public_key}`),
    }));
  });

  it("expired", async () => {
    await rejected(() => undefined, (id) => setPairingExpiry(id, Date.now() - 1));
  });

  it("already claimed (reused): the second claim fails and the first device stays", async () => {
    const pairing = await createPairing();
    const first = await claimRaw(await claimBody(pairing, await newKey()));
    expect(first.status).toBe(200);
    const again = await claimRaw(await claimBody(pairing, await newKey()));
    expect(again).toEqual({ status: 400, body: { error: "invalid pairing" } });
    expect((await pairingRow(pairing.id))!).toMatchObject({ device_id: first.body.device_id, failed_attempts: 1 });
  });

  it("5 failed attempts burn the pairing; 4 do not", async () => {
    const wrong = { secret: randomB64(32) };
    const four = await createPairing();
    for (let i = 0; i < 4; i++) expect((await claimRaw({ ...(await claimBody(four, await newKey())), ...wrong })).status).toBe(400);
    expect((await claimRaw(await claimBody(four, await newKey()))).status).toBe(200);

    const five = await createPairing();
    for (let i = 0; i < 5; i++) expect((await claimRaw({ ...(await claimBody(five, await newKey())), ...wrong })).status).toBe(400);
    expect(await claimRaw(await claimBody(five, await newKey()))).toEqual({ status: 400, body: { error: "invalid pairing" } });
    expect((await pairingRow(five.id))!).toMatchObject({ failed_attempts: 6, claimed_at: null, device_id: null });
    expect((await tokenCall("GET", `/v1/admin/pairings/${five.id}`)).body.status).toBe("expired");
  });

  it.each([
    ["an unknown id", () => ({ id: randomB64(16) })],
    ["an id that is not 16 bytes", () => ({ id: randomB64(15) })],
    ["an id that is not a string", () => ({ id: 42 })],
  ])("%s: 400 and nothing written", async (_name, override) => {
    const pairing = await createPairing();
    const res = await claimRaw({ ...(await claimBody(pairing, await newKey())), ...override() });
    expect(res).toEqual({ status: 400, body: { error: "invalid pairing" } });
    expect((await pairingRow(pairing.id))!.failed_attempts).toBe(0);
  });

  it("a pairing id must be 16 bytes, even if a row had another length", async () => {
    const id = randomB64(15);
    const secret = randomB64(32);
    await guardEnv.DB.prepare(
      `INSERT INTO admin_pairings (id, secret_hash, role, label, created_at, expires_at)
       VALUES (?, ?, 'admin', NULL, ?, ?)`,
    )
      .bind(id, await hex(secret), Date.now(), Date.now() + TEN_MIN)
      .run();
    const pairing = { id, secret, role: "admin", expires_at: 0, pair_url: "" };
    expect(await claimRaw(await claimBody(pairing, await newKey()))).toEqual({
      status: 400,
      body: { error: "invalid pairing" },
    });
    expect((await pairingRow(id))!).toMatchObject({ failed_attempts: 0, claimed_at: null });
  });

  it.each(["not json", "null", '"x"', "7"])("body %s: 400 invalid pairing", async (body) => {
    expect(await claimRaw(body)).toEqual({ status: 400, body: { error: "invalid pairing" } });
  });

  it("an array body has no name", async () => {
    expect(await claimRaw("[]")).toEqual({ status: 400, body: { error: "invalid name" } });
  });

  it("needs no credential, and a token does not change anything", async () => {
    const pairing = await createPairing();
    const res = await claimRaw(await claimBody(pairing, await newKey()), { authorization: "Bearer nope" });
    expect(res.status).toBe(200);
  });

  it("only POST", async () => {
    expect(await send("GET", "/v1/pair/claim")).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("claim rate limit", () => {
  function limiter(success: boolean) {
    const keys: string[] = [];
    const binding = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success };
      },
    } as unknown as RateLimit;
    return { keys, env: { ...guardEnv, RATE_LIMITER: binding } as GuardEnv };
  }

  it("over the limit: 429 before reading the body, keyed by IP", async () => {
    const { env, keys } = limiter(false);
    const pairing = await createPairing();
    const res = await claimRaw(await claimBody(pairing, await newKey()), { "cf-connecting-ip": "203.0.113.9" }, env);
    expect(res).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(keys).toEqual(["203.0.113.9"]);
    expect((await pairingRow(pairing.id))!.claimed_at).toBeNull();
  });

  it("within the limit: the claim goes on", async () => {
    const { env, keys } = limiter(true);
    const pairing = await createPairing();
    const body = JSON.stringify(await claimBody(pairing, await newKey()));
    expect((await send("POST", "/v1/pair/claim", { body }, env)).status).toBe(200);
    expect(keys).toEqual(["unknown"]);
  });
});

describe("GET /v1/admin/pairings/{id}", () => {
  it("pending, then claimed with the device, then approved", async () => {
    const pairing = await createPairing("read", "Ana's iPhone");
    const path = `/v1/admin/pairings/${pairing.id}`;
    const common = { role: "read", label: "Ana's iPhone", expires_at: pairing.expires_at };
    expect(await tokenCall("GET", path)).toEqual({ status: 200, body: { status: "pending", ...common } });

    const key = await newKey();
    const claimed = await claimRaw(await claimBody(pairing, key, { name: "iPhone 16 Pro", platform: "ios" }));
    const device = {
      device_id: claimed.body.device_id,
      name: "iPhone 16 Pro",
      platform: "ios",
      verification_code: await expectedCode(pairing.id, key.publicKey),
    };
    expect(await tokenCall("GET", path)).toEqual({ status: 200, body: { status: "claimed", ...common, device } });

    await tokenCall("POST", `${path}/approve`);
    expect(await tokenCall("GET", path)).toEqual({ status: 200, body: { status: "approved", ...common, device } });
  });

  it("expired: after expires_at, not at it; claimed or not", async () => {
    const T = 1_800_000_000_000;
    const pending = await createPairing();
    const { pairing: claimed } = await pairDevice("admin", false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    for (const [p, before] of [[pending, "pending"], [claimed, "claimed"]] as const) {
      const path = `/v1/admin/pairings/${p.id}`;
      await setPairingExpiry(p.id, T);
      expect((await tokenCall("GET", path)).body.status).toBe(before);
      await setPairingExpiry(p.id, T - 1);
      expect((await tokenCall("GET", path)).body.status).toBe("expired");
    }
  });

  it("4 failed attempts leave it usable; the 5th burns it (shown as expired)", async () => {
    const pairing = await createPairing();
    const path = `/v1/admin/pairings/${pairing.id}`;
    await guardEnv.DB.prepare("UPDATE admin_pairings SET failed_attempts = 4 WHERE id = ?").bind(pairing.id).run();
    expect((await tokenCall("GET", path)).body.status).toBe("pending");
    await guardEnv.DB.prepare("UPDATE admin_pairings SET failed_attempts = 5 WHERE id = ?").bind(pairing.id).run();
    expect((await tokenCall("GET", path)).body.status).toBe("expired");
  });

  it("an approved pairing stays approved after its expiry", async () => {
    const { pairing } = await pairDevice();
    await setPairingExpiry(pairing.id, Date.now() - 1);
    expect((await tokenCall("GET", `/v1/admin/pairings/${pairing.id}`)).body.status).toBe("approved");
  });

  it("unknown: 404", async () => {
    expect(await tokenCall("GET", `/v1/admin/pairings/${randomB64(16)}`)).toEqual({
      status: 404,
      body: { error: "pairing not found" },
    });
  });
});

describe("POST /v1/admin/pairings/{id}/approve", () => {
  it("activates the claimed device and logs a pair with the token as actor", async () => {
    const pairing = await createPairing("admin", "Ana's iPhone");
    const claimed = await claimRaw(await claimBody(pairing, await newKey(), { name: "iPhone", platform: "ios" }));
    const deviceId = claimed.body.device_id as string;
    const before = Date.now();
    const res = await tokenCall("POST", `/v1/admin/pairings/${pairing.id}/approve`);
    expect(res).toEqual({
      status: 200,
      body: { device_id: deviceId, name: "iPhone", platform: "ios", role: "admin", status: "active" },
    });
    expect((await deviceRow(deviceId))!.status).toBe("active");
    expect((await pairingRow(pairing.id))!.approved_at).toBeGreaterThanOrEqual(before);
    const log = await guardEnv.DB.prepare("SELECT * FROM admin_log WHERE device_id = ?").bind(deviceId).all();
    expect(log.results).toEqual([
      {
        id: expect.any(Number),
        app: null,
        action: "pair",
        kind: null,
        hash: null,
        ref: null,
        note: "Ana's iPhone",
        created_at: expect.any(Number),
        device_id: deviceId,
        actor: "token",
      },
    ]);
  });

  it.each([
    ["not claimed yet", async () => (await createPairing()).id, 409, "pairing not claimed"],
    ["already approved", async () => (await pairDevice()).pairing.id, 409, "pairing already approved"],
    [
      "expired after the claim",
      async () => {
        const { pairing } = await pairDevice("admin", false);
        await setPairingExpiry(pairing.id, Date.now() - 1);
        return pairing.id;
      },
      409,
      "pairing expired",
    ],
    ["unknown", async () => randomB64(16), 404, "pairing not found"],
  ])("%s: %i %s", async (_name, make, status, error) => {
    const id = await make();
    expect(await tokenCall("POST", `/v1/admin/pairings/${id}/approve`)).toEqual({ status, body: { error } });
  });

  it("an expired pairing does not activate its device", async () => {
    const { id, pairing } = await pairDevice("admin", false);
    await setPairingExpiry(pairing.id, Date.now() - 1);
    await tokenCall("POST", `/v1/admin/pairings/${pairing.id}/approve`);
    expect((await deviceRow(id))!.status).toBe("pending");
  });
});

describe("DELETE /v1/admin/pairings/{id}", () => {
  it("cancels a pending pairing", async () => {
    const pairing = await createPairing();
    expect(await tokenCall("DELETE", `/v1/admin/pairings/${pairing.id}`)).toEqual({
      status: 200,
      body: { cancelled: true },
    });
    expect(await pairingRow(pairing.id)).toBeNull();
    expect((await claimRaw(await claimBody(pairing, await newKey()))).status).toBe(400);
  });

  it("cancels a claimed one and deletes its pending device", async () => {
    const other = await pairDevice("admin", false);
    const { id, pairing } = await pairDevice("admin", false);
    expect((await tokenCall("DELETE", `/v1/admin/pairings/${pairing.id}`)).status).toBe(200);
    expect(await deviceRow(id)).toBeNull();
    expect(await deviceRow(other.id)).not.toBeNull();
  });

  it("an approved pairing cannot be cancelled: revoke the device instead", async () => {
    const { id, pairing } = await pairDevice();
    expect(await tokenCall("DELETE", `/v1/admin/pairings/${pairing.id}`)).toEqual({
      status: 409,
      body: { error: "pairing already approved" },
    });
    expect((await deviceRow(id))!.status).toBe("active");
  });

  it("unknown: 404", async () => {
    expect(await tokenCall("DELETE", `/v1/admin/pairings/${randomB64(16)}`)).toEqual({
      status: 404,
      body: { error: "pairing not found" },
    });
  });
});

describe("daily cron: nonces, pairings and pending devices", () => {
  it("deletes what expired and keeps the rest", async () => {
    const now = Date.now();
    const active = await pairDevice();
    const pendingLive = await pairDevice("admin", false);
    const pendingExpired = await pairDevice("admin", false);
    await setPairingExpiry(pendingExpired.pairing.id, now - 1);
    const pendingBurned = await pairDevice("admin", false);
    await guardEnv.DB.prepare("UPDATE admin_pairings SET failed_attempts = 5 WHERE id = ?")
      .bind(pendingBurned.pairing.id)
      .run();
    const orphan = await pairDevice("admin", false);
    await guardEnv.DB.prepare("DELETE FROM admin_pairings WHERE id = ?").bind(orphan.pairing.id).run();
    await setPairingExpiry(active.pairing.id, now - 1);
    const unclaimedExpired = await createPairing();
    await setPairingExpiry(unclaimedExpired.id, now - 1);
    const unclaimedLive = await createPairing();

    const nonce = guardEnv.DB.prepare("INSERT INTO admin_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)");
    await guardEnv.DB.batch([nonce.bind(active.id, "old", now - 1), nonce.bind(active.id, "new", now + 60_000)]);

    await worker.scheduled!({} as never, guardEnv);

    expect(await deviceRow(active.id)).not.toBeNull();
    expect(await deviceRow(pendingLive.id)).not.toBeNull();
    expect(await deviceRow(pendingExpired.id)).toBeNull();
    expect(await deviceRow(pendingBurned.id)).toBeNull();
    expect(await deviceRow(orphan.id)).toBeNull();
    expect(await pairingRow(active.pairing.id)).toBeNull();
    expect(await pairingRow(unclaimedExpired.id)).toBeNull();
    expect(await pairingRow(unclaimedLive.id)).not.toBeNull();
    expect(await pairingRow(pendingLive.pairing.id)).not.toBeNull();
    expect(await nonceCount(active.id)).toBe(1);
  });
});
