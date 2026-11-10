// POST /v1/device/check (docs/DESIGN.md, section 6.1).

import type { AppleEnv, DeviceCheckClient, TwoBits } from "./apple/devicecheck";
import type { AppConfig } from "./env";
import { isAppId } from "./env";
import { isHash, refFromInstallHash, type Kind } from "./hash";
import type { IdHash, Store } from "./store";

export const INTENTS = ["launch", "foreground", "login", "signup"] as const;
export type Intent = (typeof INTENTS)[number];

export interface CheckRequest {
  app: string;
  env: AppleEnv;
  /** Token for query_two_bits. */
  dcToken: string | null;
  /**
   * Second token, for update_two_bits. Apple asks not to reuse a token, so the SDK generates
   * two. If it is missing, nothing is written to Apple: it is retried on the next check.
   */
  dcTokenUpdate: string | null;
  ids: IdHash[];
  ref: string;
  intent: Intent;
}

export interface CheckResult {
  status: "ok" | "blocked";
  ref: string;
}

const TOKEN_RE = /^[A-Za-z0-9+/=_-]{16,8192}$/;
const ID_KINDS: readonly Kind[] = ["idfv", "install", "icloud", "user"];

const optionalToken = (v: unknown): string | null | undefined =>
  v === undefined || v === null ? null : typeof v === "string" && TOKEN_RE.test(v) ? v : undefined;

/** Validates the body. Returns `null` if it is invalid. The `ref` is derived here; the client's is never trusted. */
export function parseCheckRequest(body: unknown): CheckRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (!isAppId(b.app)) return null;
  const env = b.env ?? "production";
  if (env !== "development" && env !== "production") return null;
  const intent = b.intent ?? "launch";
  if (!(INTENTS as readonly unknown[]).includes(intent)) return null;

  const dcToken = optionalToken(b.dc_token);
  const dcTokenUpdate = optionalToken(b.dc_token_update);
  if (dcToken === undefined || dcTokenUpdate === undefined) return null;

  if (typeof b.ids !== "object" || b.ids === null) return null;
  const rawIds = b.ids as Record<string, unknown>;
  const ids: IdHash[] = [];
  for (const kind of ID_KINDS) {
    const v = rawIds[kind];
    if (v === undefined || v === null) continue;
    if (!isHash(v)) return null;
    ids.push({ kind, hash: v });
  }
  const install = ids.find((id) => id.kind === "install");
  if (!install) return null;

  return {
    app: b.app,
    env,
    dcToken,
    dcTokenUpdate,
    ids,
    ref: refFromInstallHash(install.hash),
    intent: intent as Intent,
  };
}

export interface CheckDeps {
  store: Store;
  /** `null` if the app has no DeviceCheck key. */
  deviceCheck: DeviceCheckClient | null;
  now: number;
}

export async function runCheck(
  req: CheckRequest,
  config: AppConfig,
  { store, deviceCheck, now }: CheckDeps,
): Promise<CheckResult> {
  const { app, ref } = req;
  const dc = deviceCheck && req.dcToken ? deviceCheck : null;
  // No second token, no write: reusing the query token goes against what Apple asks.
  const updateToken = req.dcTokenUpdate;

  const [matched, unban, bits] = await Promise.all([
    store.anyBanned(app, req.ids.map((id) => id.hash)),
    store.pendingUnban(app, ref),
    dc ? dc.query(req.env, req.dcToken!) : Promise.resolve<TwoBits | null>(null),
  ]);

  const log = (blocked: boolean, bit0: boolean | null) =>
    store.logCheck(app, { ref, blocked, matched, bit0, intent: req.intent }, now);

  if (unban) {
    // Full unban: bit0 set to false and the hashes this device sends removed, since the admin
    // cannot work them out from the ref. It is only consumed once the bit is clear; if Apple
    // fails or the request lacks either of the two tokens, let the device in and retry on the
    // next check (consuming it would leave bit0 set and the device would be blocked again).
    // Without an Apple key there is no bit to clear: it is consumed with D1 alone.
    const cleared = deviceCheck ? (dc && updateToken ? await dc.setBit0(req.env, updateToken, false) : false) : true;
    if (cleared) {
      await store.removeHashes(app, req.ids.map((id) => id.hash));
      await store.consumeUnban(app, ref, now);
    }
    await log(false, cleared && dc ? false : (bits?.bit0 ?? null));
    return { status: "ok", ref };
  }

  const blocked = matched || bits?.bit0 === true;

  // Observation mode (no ENFORCE): only the verdict is logged. Nothing is written to Apple and
  // nothing is propagated, so a wrong ban during observation leaves no trace. Once ENFORCE is
  // on, the first check of each blocked device does both.
  if (config.enforce) {
    if (matched && dc && updateToken && bits && !bits.bit0) {
      await dc.setBit0(req.env, updateToken, true);
    }
    // Propagation: a blocked device marks all of its identifiers, so the block jumps to other
    // devices with the same iCloud account. Existing rows are not overwritten.
    if (blocked) {
      await store.insertPropagated(app, req.ids, now);
    }
  }

  await log(blocked, bits?.bit0 ?? null);

  return { status: blocked && config.enforce ? "blocked" : "ok", ref };
}
