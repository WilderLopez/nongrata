// POST /v1/device/check (docs/DESIGN.md, section 6.1).

import type { AppleEnv, DeviceCheckClient, TwoBits } from "./apple/devicecheck";
import type { AppConfig } from "./env";
import { isAppId } from "./env";
import { hashId, isHash, refFromInstallHash, type Kind } from "./hash";
import type { IdHash, Store } from "./store";

// `refresh` is a check the app forces (its own push arrived, its backend reported a blocked
// account, a timer while it is open): the SDK never throttles it.
export const INTENTS = ["launch", "foreground", "login", "signup", "refresh"] as const;
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
  /** The `install` hash, which is also in `ids`: it names the device. */
  install: string;
  ref: string;
  intent: Intent;
  /**
   * `"android"` for a client without DeviceCheck; absent for every other request, which takes
   * the iOS path exactly as before (the Swift SDK sends `platform: "ios"`, never validated).
   */
  platform?: "android";
}

export interface CheckResult {
  status: "ok" | "blocked";
  ref: string;
}

const TOKEN_RE = /^[A-Za-z0-9+/=_-]{16,8192}$/;
const ID_KINDS: readonly Kind[] = ["idfv", "install", "icloud", "user"];
// Android has no idfv, iCloud account or DeviceCheck; ANDROID_ID survives a reinstall.
const ANDROID_ID_KINDS: readonly Kind[] = ["install", "user", "android_id"];
const APPLE_ONLY_KINDS: readonly Kind[] = ["idfv", "icloud"];

const present = (v: unknown) => v !== undefined && v !== null;

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

  // Only "android" changes anything. An Android request with Apple's fields is a mix-up, not a
  // device: rejected rather than half-read.
  const android = b.platform === "android";
  if (android && (dcToken !== null || dcTokenUpdate !== null)) return null;
  if (android && APPLE_ONLY_KINDS.some((kind) => present(rawIds[kind]))) return null;

  const ids: IdHash[] = [];
  for (const kind of android ? ANDROID_ID_KINDS : ID_KINDS) {
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
    install: install.hash,
    ref: refFromInstallHash(install.hash),
    intent: intent as Intent,
    ...(android ? { platform: "android" as const } : {}),
  };
}

/** A link already stored is touched again only when it is older than this. */
const LINK_REFRESH_MS = 24 * 3600 * 1000;

export interface CheckDeps {
  store: Store;
  /** `null` if the app has no DeviceCheck key. */
  deviceCheck: DeviceCheckClient | null;
  now: number;
}

export async function runCheck(
  req: CheckRequest,
  config: AppConfig,
  deps: CheckDeps,
): Promise<CheckResult> {
  const { store, now } = deps;
  const { app, ref } = req;
  // An Android device has no DeviceCheck: no query, no write, and an unban by ref is consumed
  // with D1 alone, as in an app without an Apple key. The iOS path is untouched.
  const deviceCheck = req.platform === "android" ? null : deps.deviceCheck;
  const platform = req.platform ?? "ios";
  // The hash of an empty user ID is the same for every device that sends it. Matched, propagated
  // or linked, one ban would block everyone signed out, so it is dropped before anything else.
  const emptyUser = await hashId(config.hashPrefix, "user", "");
  const ids = req.ids.filter((id) => !(id.kind === "user" && id.hash === emptyUser));
  const dc = deviceCheck && req.dcToken ? deviceCheck : null;
  // No second token, no write: reusing the query token goes against what Apple asks.
  const updateToken = req.dcTokenUpdate;

  const hashes = ids.map((id) => id.hash);
  // With LINK_USERS, the device answers for the request's hashes and for the users it has
  // carried: a ban by `user` reaches it even signed out or under another account. Without it,
  // no query touches `user_links`.
  const linked = config.linkUsers ? req.install : null;
  const user = ids.find((id) => id.kind === "user");
  const [matched, unban, bits] = await Promise.all([
    store.anyBanned(app, hashes, linked),
    store.pendingUnban(app, ref),
    dc ? dc.query(req.env, req.dcToken!) : Promise.resolve<TwoBits | null>(null),
    // The link is not a ban, so it is kept in observation mode too.
    linked && user ? store.linkUser(app, linked, user.hash, now, now - LINK_REFRESH_MS) : null,
  ]);

  const log = (blocked: boolean, bit0: boolean | null) =>
    store.logCheck(app, { ref, blocked, matched, bit0, intent: req.intent, platform }, now);

  if (unban !== null) {
    if (await store.manualBanAfter(app, hashes, unban, linked)) {
      // The last decision wins: a manual ban made after the unban was scheduled cancels it,
      // and the device is judged like any other. Banning an `install` already cancels it when
      // the ban is made (the ref is known then); this catches the other kinds, whose device
      // only shows up here, and the ban of a user this device has carried.
      await store.cancelUnban(app, ref);
    } else {
      // Full unban: bit0 set to false and the hashes this device sends removed (its automatic
      // bans went when the unban was scheduled; this also catches manual ones and older rows
      // without a ref). It is only consumed once the bit is clear; if Apple fails or the
      // request lacks either of the two tokens, let the device in and retry on the next check
      // (consuming it would leave bit0 set and the device would be blocked again). Without an
      // Apple key there is no bit to clear: it is consumed with D1 alone.
      const cleared = deviceCheck ? (dc && updateToken ? await dc.setBit0(req.env, updateToken, false) : false) : true;
      if (cleared) {
        await store.removeHashes(app, hashes, unban);
        // The users this device carried and does not send now stay banned: what goes is its
        // link to them, or their ban would block it again on the next check.
        if (linked) await store.unlinkBanned(app, linked, unban);
        await store.consumeUnban(app, ref, now);
      }
      await log(false, cleared && dc ? false : (bits?.bit0 ?? null));
      return { status: "ok", ref };
    }
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
      await store.insertPropagated(app, ref, ids, now);
    }
  }

  await log(blocked, bits?.bit0 ?? null);

  return { status: blocked && config.enforce ? "blocked" : "ok", ref };
}
