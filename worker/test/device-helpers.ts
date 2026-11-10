// Admin devices in the tests: a P-256 key made with WebCrypto, pairing through the real routes,
// and requests signed with a canonical string built here, apart from src/signature.ts.

import type { GuardEnv } from "../src/env";
import { handle } from "../src/index";
import { guardEnv } from "./helpers";

export const ORIGIN = "https://guard.test";
export const TOKEN = "test-admin-token";

type Body = Record<string, unknown>;

const enc = (text: string) => new TextEncoder().encode(text);

export const b64 = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const randomB64 = (n: number) => b64(crypto.getRandomValues(new Uint8Array(n)));

export async function hex(data: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc(data) : data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DeviceKey {
  privateKey: CryptoKey;
  publicKey: string;
}

export async function newKey(): Promise<DeviceKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: b64((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer) };
}

export const signText = async (key: CryptoKey, text: string) =>
  b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(text)));

/** Section 2.3, computed here on its own. */
export async function expectedCode(id: string, publicKey: string): Promise<string> {
  const n = parseInt((await hex(`NONGRATA-VERIFY-V1\n${id}\n${publicKey}`)).slice(0, 8), 16);
  return String(n % 1_000_000).padStart(6, "0");
}

export async function send(
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
  env: GuardEnv = guardEnv,
) {
  const res = await handle(new Request(`${ORIGIN}${path}`, { method, headers: init.headers, body: init.body }), env);
  return { status: res.status, body: (await res.json()) as Body };
}

/** A request with `Authorization: Bearer <ADMIN_TOKEN>`. */
export const tokenCall = (method: string, path: string, payload?: Body, env: GuardEnv = guardEnv) =>
  send(
    method,
    path,
    {
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    env,
  );

export interface Pairing {
  id: string;
  secret: string;
  role: string;
  expires_at: number;
  pair_url: string;
}

export async function createPairing(role = "admin", label?: string): Promise<Pairing> {
  const res = await tokenCall("POST", "/v1/admin/pairings", label === undefined ? { role } : { role, label });
  if (res.status !== 200) throw new Error(`pairing: ${JSON.stringify(res)}`);
  return res.body as unknown as Pairing;
}

export interface ClaimFields {
  id: string;
  secret: string;
  public_key: string;
  name: unknown;
  platform: unknown;
  proof: string;
}

export async function claimBody(pairing: Pairing, key: DeviceKey, extra: Partial<ClaimFields> = {}) {
  return {
    id: pairing.id,
    secret: pairing.secret,
    public_key: key.publicKey,
    name: "iPhone 16 Pro",
    platform: "ios",
    proof: await signText(key.privateKey, `NONGRATA-PAIR-V1\n${pairing.id}\n${key.publicKey}`),
    ...extra,
  };
}

/** A random client IP each time, so the dev rate limit (20 a minute per IP) never kicks in. */
const randomIp = () => `198.51.100.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

export const claimRaw = (body: unknown, headers: Record<string, string> = {}, env: GuardEnv = guardEnv) =>
  send(
    "POST",
    "/v1/pair/claim",
    {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "cf-connecting-ip": randomIp(), ...headers },
    },
    env,
  );

export interface Device {
  id: string;
  key: DeviceKey;
  pairing: Pairing;
}

/** Pairs a device: create, claim and, unless `approve` is false, approve. */
export async function pairDevice(role = "admin", approve = true): Promise<Device> {
  const pairing = await createPairing(role);
  const key = await newKey();
  const claimed = await claimRaw(await claimBody(pairing, key));
  if (claimed.status !== 200) throw new Error(`claim: ${JSON.stringify(claimed)}`);
  const id = claimed.body.device_id as string;
  if (approve) {
    const approved = await tokenCall("POST", `/v1/admin/pairings/${pairing.id}/approve`);
    if (approved.status !== 200) throw new Error(`approve: ${JSON.stringify(approved)}`);
  }
  return { id, key, pairing };
}

export interface SignOptions {
  body?: string;
  timestamp?: number;
  nonce?: string;
  /** Sign as if the request went to this host, method, path or body. */
  signedHost?: string;
  signedMethod?: string;
  signedPath?: string;
  signedQuery?: string;
  signedBody?: string;
  /** Replaces or adds headers after signing (`null` removes one). */
  headers?: Record<string, string | null>;
  key?: CryptoKey;
  env?: GuardEnv;
}

/**
 * A request signed by `device`. Test queries only use unreserved characters and distinct names,
 * so sorting the "name=value" pairs is the canonical query.
 */
export async function signedCall(device: Pick<Device, "id" | "key">, method: string, path: string, o: SignOptions = {}) {
  const url = new URL(`${ORIGIN}${path}`);
  const timestamp = String(o.timestamp ?? Date.now());
  const nonce = o.nonce ?? randomB64(16);
  const query = [...url.searchParams].map(([k, v]) => `${k}=${v}`).sort().join("&");
  const canonical = [
    "NONGRATA-SIG-V1",
    o.signedMethod ?? method,
    o.signedHost ?? url.host,
    o.signedPath ?? url.pathname,
    o.signedQuery ?? query,
    timestamp,
    nonce,
    device.id,
    await hex(o.signedBody ?? o.body ?? ""),
  ].join("\n");
  const headers: Record<string, string> = {
    "nongrata-device": device.id,
    "nongrata-timestamp": timestamp,
    "nongrata-nonce": nonce,
    "nongrata-signature": await signText(o.key ?? device.key.privateKey, canonical),
  };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return send(method, path, { body: o.body, headers }, o.env);
}

export async function deviceRow(id: string) {
  return guardEnv.DB.prepare("SELECT * FROM admin_devices WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

export async function pairingRow(id: string) {
  return guardEnv.DB.prepare("SELECT * FROM admin_pairings WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

export async function nonceCount(deviceId: string) {
  const row = await guardEnv.DB.prepare("SELECT COUNT(*) AS n FROM admin_nonces WHERE device_id = ?")
    .bind(deviceId)
    .first<{ n: number }>();
  return row!.n;
}

/** Moves a pairing's expiry (to make it expire without waiting). */
export async function setPairingExpiry(id: string, expiresAt: number) {
  await guardEnv.DB.prepare("UPDATE admin_pairings SET expires_at = ? WHERE id = ?").bind(expiresAt, id).run();
}
