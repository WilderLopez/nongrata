// Admin devices (docs/DEVICE-PAIRING.md): who is calling /v1/admin/* (the ADMIN_TOKEN or a paired
// device that signs its requests), what each one may call, pairing, and the device endpoints.
// The cryptography is in signature.ts and the SQL in store.ts.

import { isAuthorized, readBody } from "./admin";
import { appConfig, isAppId, type GuardEnv } from "./env";
import { json } from "./http";
import {
  canonicalString,
  fromB64url,
  pairProofMessage,
  randomToken,
  sameDigest,
  sha256Hex,
  verificationCode,
  verifySignature,
} from "./signature";
import type { Actor, DeviceRow, PairingWithDevice, Platform, Role, Store } from "./store";

const MINUTE_MS = 60_000;
export const PAIRING_TTL_MS = 10 * MINUTE_MS;
export const MAX_FAILED_CLAIMS = 5;
/** Largest accepted |now − NonGrata-Timestamp|. */
export const CLOCK_WINDOW_MS = 5 * MINUTE_MS;
/** How long a nonce is kept, from its request's timestamp: longer than the window on either side. */
export const NONCE_TTL_MS = 10 * MINUTE_MS;
/** `last_used_at` is written at most this often. */
export const TOUCH_EVERY_MS = MINUTE_MS;

const ROLES: readonly unknown[] = ["read", "admin"];
const PLATFORMS: readonly unknown[] = ["ios", "ipados", "macos", "other"];
const MAX_TEXT = 64;

/** The identity of an admin request. */
export type Caller = { kind: "token" } | { kind: "device"; device: DeviceRow };

export const actorOf = (caller: Caller): Actor => (caller.kind === "token" ? "token" : `device:${caller.device.id}`);

/**
 * Who may call a route (section 4): `me` only a device, also a pending one; `read` the token and
 * any device; `admin` the token and admin devices; `token` only the token. `revoke` is `admin`,
 * plus any device on itself.
 */
export type Access = "me" | "read" | "admin" | "revoke" | "token";

const unauthorized = () => json({ error: "unauthorized" }, 401);

/** A non-empty string of at most 64 UTF-16 code units (clients truncate before sending). */
const isShortText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;

/** The pairing link must be https; plain http only towards `wrangler dev` on this machine. */
const isSecureOrigin = (url: URL): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));

/** IDs (pairing, device) and nonces: 16 random bytes in base64url. */
const isToken16 = (value: unknown): value is string => typeof value === "string" && fromB64url(value, 16) !== null;

/**
 * Authenticates a request to /v1/admin/*. Without `NonGrata-Device`, exactly as before: the
 * Bearer `ADMIN_TOKEN` or 401. With it, the signed-request checks of section 3.4, in order; the
 * nonce is stored only once the signature verifies. A pending device authenticates while its
 * pairing lives; `allows` then lets it call only `me`.
 */
export async function authenticate(
  request: Request,
  url: URL,
  env: GuardEnv,
  store: Store,
  now: number,
): Promise<Caller | Response> {
  const h = request.headers;
  const deviceId = h.get("nongrata-device");
  if (deviceId === null) return (await isAuthorized(request, env)) ? { kind: "token" } : unauthorized();
  if (h.has("authorization")) return json({ error: "ambiguous credentials" }, 400);

  // Malformed headers are rejected before reading D1, with the same answer as a bad signature.
  // Stryker disable next-line StringLiteral: a missing header and any non-decimal default fail the same format check.
  const timestamp = h.get("nongrata-timestamp") ?? "";
  const nonce = h.get("nongrata-nonce");
  // Stryker disable next-line StringLiteral: a missing header and any default that is not 64 bytes fail the same way.
  const signature = fromB64url(h.get("nongrata-signature") ?? "", 64);
  if (!isToken16(deviceId) || !/^\d{1,15}$/.test(timestamp) || !isToken16(nonce) || !signature) {
    return unauthorized();
  }

  // 1. The device exists, is not revoked, and is active (or pending, while its pairing lives).
  const device = await store.getDevice(deviceId);
  if (!device || device.revoked_at !== null) return unauthorized();
  if (device.status !== "active" && (device.pairing_expires_at ?? 0) < now) return unauthorized();

  // 2. The clock: the only failure that says why, so the app can tell its user.
  const time = Number(timestamp);
  if (Math.abs(now - time) > CLOCK_WINDOW_MS) {
    return json({ error: "unauthorized", reason: "clock", server_time: now }, 401);
  }

  // 3. The signature, over the canonical string.
  const body = await request.clone().arrayBuffer();
  const message = canonicalString({
    method: request.method,
    url,
    timestamp,
    nonce,
    device: deviceId,
    bodyHash: await sha256Hex(body),
  });
  const publicKey = fromB64url(device.public_key, 65)!;
  if (!(await verifySignature(publicKey, signature, message))) return unauthorized();

  // 4. The nonce is new. Only now does the request write to D1.
  if (!(await store.useNonce(deviceId, nonce, time + NONCE_TTL_MS, now))) return unauthorized();

  const { pairing_expires_at: _, ...row } = device;
  return { kind: "device", device: row };
}

/** What each access level lets a device do; `target` is the device of `revoke`. */
const DEVICE_MAY: Record<Access, (device: DeviceRow, target?: string) => boolean> = {
  me: () => true,
  read: () => true,
  admin: (device) => device.role === "admin",
  revoke: (device, target) => device.role === "admin" || device.id === target,
  token: () => false,
};

/** Step 5 of section 3.4: whether the role allows the route. A pending device may only call `me`. */
export function allows(caller: Caller, access: Access, target?: string): boolean {
  if (caller.kind === "token") return access !== "me";
  if (caller.device.status === "pending") return access === "me";
  return DEVICE_MAY[access](caller.device, target);
}

/** Records the use of an authenticated device, at most once a minute. */
export async function touch(caller: Caller, store: Store, now: number): Promise<void> {
  if (caller.kind !== "device") return;
  if (now - (caller.device.last_used_at ?? 0) >= TOUCH_EVERY_MS) await store.touchDevice(caller.device.id, now);
}

// ---------------------------------------------------------------------------------------------
// Pairing (section 2)

/** `POST /v1/admin/pairings` (token only). */
export async function createPairing(request: Request, url: URL, store: Store, now: number) {
  if (!isSecureOrigin(url)) return json({ error: "https required" }, 400);
  const b = (await readBody(request)) ?? {};
  if (!ROLES.includes(b.role)) return json({ error: "invalid role" }, 400);
  const role = b.role as Role;
  if (b.label !== undefined && b.label !== null && !isShortText(b.label)) return json({ error: "invalid label" }, 400);
  const label = (b.label as string | undefined) ?? null;

  const id = randomToken(16);
  const secret = randomToken(32);
  const expiresAt = now + PAIRING_TTL_MS;
  await store.createPairing({
    id,
    secret_hash: await sha256Hex(secret),
    role,
    label,
    created_at: now,
    expires_at: expiresAt,
  });
  // `role` and `exp` are hints for the device's screen; the Worker's stored role is the one that counts.
  const pairUrl =
    `nongrata://pair?v=1&url=${encodeURIComponent(url.origin)}&id=${id}&secret=${secret}` +
    `&role=${role}&exp=${expiresAt}`;
  return json({ id, secret, role, expires_at: expiresAt, pair_url: pairUrl });
}

type PairingStatus = "pending" | "claimed" | "approved" | "expired";

/** A burned pairing (too many failed claims) shows as `expired`: it cannot be used any more. */
function statusOf(p: PairingWithDevice, now: number): PairingStatus {
  if (p.approved_at !== null) return "approved";
  if (now > p.expires_at || p.failed_attempts >= MAX_FAILED_CLAIMS) return "expired";
  return p.claimed_at === null ? "pending" : "claimed";
}

const pairingNotFound = () => json({ error: "pairing not found" }, 404);

/** `GET /v1/admin/pairings/{id}` (token only). */
export async function getPairing(id: string, store: Store, now: number) {
  const p = await store.getPairing(id);
  if (!p) return pairingNotFound();
  const result: Record<string, unknown> = {
    status: statusOf(p, now),
    role: p.role,
    label: p.label,
    expires_at: p.expires_at,
  };
  if (p.device) {
    result.device = {
      device_id: p.device_id,
      name: p.device.name,
      platform: p.device.platform,
      verification_code: await verificationCode(p.id, p.device.public_key),
    };
  }
  return json(result);
}

const NOT_APPROVABLE: Record<Exclude<PairingStatus, "claimed">, string> = {
  pending: "pairing not claimed",
  approved: "pairing already approved",
  expired: "pairing expired",
};

/** `POST /v1/admin/pairings/{id}/approve` (token only): only a claimed pairing that has not expired. */
export async function approvePairing(id: string, store: Store, caller: Caller, now: number) {
  const p = await store.getPairing(id);
  if (!p) return pairingNotFound();
  const status = statusOf(p, now);
  if (status !== "claimed") return json({ error: NOT_APPROVABLE[status] }, 409);
  // A claimed pairing always has its device: only the cron and this pairing's DELETE remove it.
  const device = p.device!;
  const deviceId = p.device_id!;
  await store.approvePairing({ ...p, device_id: deviceId }, actorOf(caller), now);
  return json({ device_id: deviceId, name: device.name, platform: device.platform, role: p.role, status: "active" });
}

/** `DELETE /v1/admin/pairings/{id}` (token only): cancels it and deletes its pending device. */
export async function cancelPairing(id: string, store: Store) {
  const p = await store.getPairing(id);
  if (!p) return pairingNotFound();
  if (p.approved_at !== null) return json({ error: "pairing already approved" }, 409);
  await store.cancelPairing(id);
  return json({ cancelled: true });
}

const invalidPairing = () => json({ error: "invalid pairing" }, 400);

/**
 * `POST /v1/pair/claim` (no credential; rate-limited by the caller). The shape of `name` and
 * `platform` is checked first, without touching the pairing, and named in the error. After that
 * every failure is the same `400 invalid pairing`, and every failure on an existing pairing
 * counts towards burning it.
 */
export async function claim(request: Request, store: Store, now: number) {
  const b = await readBody(request);
  if (!b) return invalidPairing();
  if (!isShortText(b.name)) return json({ error: "invalid name" }, 400);
  if (!PLATFORMS.includes(b.platform)) return json({ error: "invalid platform" }, 400);
  if (!isToken16(b.id)) return invalidPairing();
  const pairing = await store.getPairing(b.id);
  if (!pairing) return invalidPairing();

  const device = await checkClaim(pairing.id, pairing.secret_hash, b);
  const claimed =
    device !== null &&
    (await store.claimPairing(pairing.id, pairing.secret_hash, device, MAX_FAILED_CLAIMS, now));
  if (!claimed) {
    await store.failPairing(pairing.id);
    return invalidPairing();
  }
  return json({
    device_id: device.id,
    role: pairing.role,
    verification_code: await verificationCode(pairing.id, device.publicKey),
  });
}

/**
 * The parts of a claim that do not depend on the pairing's state: the secret (in constant time),
 * the key and the proof. `name` and `platform` were checked by `claim`. The state (expired,
 * claimed, burned) is decided by the conditional UPDATE in `Store.claimPairing`.
 */
async function checkClaim(pairingId: string, secretHash: string, b: Record<string, unknown>) {
  if (typeof b.secret !== "string" || !sameDigest(await sha256Hex(b.secret), secretHash)) return null;
  // 65 bytes; `verifySignature` then rejects anything that is not an uncompressed point (0x04).
  const publicKey = typeof b.public_key === "string" ? fromB64url(b.public_key, 65) : null;
  const proof = typeof b.proof === "string" ? fromB64url(b.proof, 64) : null;
  if (!publicKey || !proof) return null;
  const message = pairProofMessage(pairingId, b.public_key as string);
  if (!(await verifySignature(publicKey, proof, message))) return null;
  return { id: randomToken(16), name: b.name as string, platform: b.platform as Platform, publicKey: b.public_key as string };
}

// ---------------------------------------------------------------------------------------------
// Devices and apps (sections 4 and 5)

const deviceItem = (d: DeviceRow) => ({
  device_id: d.id,
  name: d.name,
  platform: d.platform,
  role: d.role,
  status: d.status,
  created_at: d.created_at,
  last_used_at: d.last_used_at,
  revoked_at: d.revoked_at,
});

/** `GET /v1/admin/me` (devices only, also pending). */
export function me(caller: Caller & { kind: "device" }) {
  const { device_id, name, platform, role, status, created_at } = deviceItem(caller.device);
  return json({ device_id, name, platform, role, status, created_at });
}

/**
 * `GET /v1/admin/apps`: the apps with a `HASH_PREFIX_<APP>`. The Worker only sees the variable's
 * suffix, so the app is that suffix in lowercase (an app id with "-" shows with "_").
 */
export function apps(env: GuardEnv) {
  const list = Object.keys(env)
    .filter((key) => key.startsWith("HASH_PREFIX_"))
    .map((key) => key.slice("HASH_PREFIX_".length).toLowerCase())
    .filter(isAppId)
    .sort()
    .flatMap((app) => {
      const config = appConfig(env, app);
      return config ? [{ app, enforce: config.enforce, devicecheck: config.apple !== undefined }] : [];
    });
  return json({ apps: list });
}

/** `GET /v1/admin/devices`: every device, newest first, never the public key. */
export async function listDevices(store: Store) {
  return json({ devices: (await store.listDevices()).map(deviceItem) });
}

/**
 * `POST /v1/admin/devices/{id}/revoke`: permanent and idempotent. Revoking again answers the
 * original `revoked_at` and writes nothing.
 */
export async function revokeDevice(id: string, store: Store, caller: Caller, now: number) {
  const device = await store.getDevice(id);
  if (!device) return json({ error: "not_found" }, 404);
  if (device.revoked_at !== null) return json({ device_id: id, revoked_at: device.revoked_at });
  await store.revokeDevice(id, actorOf(caller), now);
  return json({ device_id: id, revoked_at: now });
}
