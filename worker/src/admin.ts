// /v1/admin/* endpoints (docs/DESIGN.md, section 6.4; docs/ADMIN-API.md and its OpenAPI spec,
// docs/admin-api.yaml). All of them require Bearer ADMIN_TOKEN.

import { b64url } from "./apple/jwt";
import { appConfig, isAppId, type AppConfig, type GuardEnv } from "./env";
import { hashId, isHash, isKind, isRef, type Kind } from "./hash";
import { json } from "./http";
import type { After, BanReason, Store } from "./store";

/** Query string parameters; a repeated one keeps its last value. */
type Query = Record<string, string | undefined>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function isAuthorized(request: Request, env: GuardEnv): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  // Stryker disable next-line StringLiteral: with no header, any default value without "Bearer " gives given = "".
  const header = request.headers.get("authorization") ?? "";
  // Stryker disable next-line StringLiteral: changing the trailing "" only matters if ADMIN_TOKEN were that exact text.
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Compare the digests so the comparison does not depend on the length.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * App with a valid format and configured in this Worker. A typo in `app` must not return a 200
 * that stores rows nobody reads, not even with `hash` or `ref`.
 */
function configuredApp(env: GuardEnv, app: unknown): AppConfig | Response {
  if (!isAppId(app)) return json({ error: "invalid app" }, 400);
  return appConfig(env, app) ?? json({ error: "app not configured" }, 400);
}

/** Resolves `{ kind, value }` or `{ kind, hash }` to a hash. `value` is hashed with the app's prefix. */
async function resolveId(
  config: AppConfig,
  b: Record<string, unknown>,
): Promise<{ kind: Kind; hash: string } | { error: string } | null> {
  if (b.value === undefined && b.hash === undefined) return null;
  if (!isKind(b.kind)) return { error: "invalid kind" };
  if (isHash(b.hash)) return { kind: b.kind, hash: b.hash };
  if (b.hash !== undefined) return { error: "invalid hash" };
  if (typeof b.value !== "string" || b.value.length === 0) return { error: "invalid value" };
  return { kind: b.kind, hash: await hashId(config.hashPrefix, b.kind, b.value) };
}

// Stryker disable all: redundant; the callers reject anything that is not an object with a valid `app` anyway.
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
// Stryker restore all

export async function ban(request: Request, env: GuardEnv, store: Store, now: number) {
  const b = (await readBody(request)) ?? {};
  const config = configuredApp(env, b.app);
  if (config instanceof Response) return config;
  const { app } = config;
  const id = await resolveId(config, b);
  if (!id) return json({ error: "missing value or hash" }, 400);
  if ("error" in id) return json(id, 400);
  const note = typeof b.note === "string" ? b.note.slice(0, 500) : null;
  // The ban and its admin_log row go in one transaction.
  await store.banManual(app, id, note, now);
  return json({ app, kind: id.kind, hash: id.hash });
}

export async function unban(request: Request, env: GuardEnv, store: Store, now: number) {
  const b = (await readBody(request)) ?? {};
  const config = configuredApp(env, b.app);
  if (config instanceof Response) return config;
  const { app } = config;

  const id = await resolveId(config, b);
  if (id && "error" in id) return json(id, 400);
  if (b.ref !== undefined && !isRef(b.ref)) return json({ error: "invalid ref" }, 400);
  if (!id && b.ref === undefined) return json({ error: "missing value, hash or ref" }, 400);

  const ref = isRef(b.ref) ? b.ref : null;
  // Deleting, scheduling and the admin_log row go in one transaction.
  const removed = await store.unban(app, id, ref, now);
  const result: Record<string, unknown> = { app };
  if (id) {
    result.hash = id.hash;
    result.removed = removed;
  }
  if (ref) {
    result.ref = ref;
    result.unban_scheduled = true;
  }
  return json(result);
}

export async function lookup(url: URL, env: GuardEnv, store: Store) {
  const p = Object.fromEntries(url.searchParams) as Record<string, unknown>;
  const config = configuredApp(env, p.app);
  if (config instanceof Response) return config;
  const { app } = config;

  if (p.ref !== undefined) {
    if (!isRef(p.ref)) return json({ error: "invalid ref" }, 400);
    const [unbanRow, checks] = await Promise.all([
      store.getUnban(app, p.ref),
      store.recentChecks(app, p.ref),
    ]);
    return json({ app, ref: p.ref, unban: unbanRow, checks });
  }

  const id = await resolveId(config, p);
  if (!id) return json({ error: "missing ref, value or hash" }, 400);
  if ("error" in id) return json(id, 400);
  return json({ app, hash: id.hash, banned: await store.getBanned(app, id.hash) });
}

/** A whole number in decimal digits (no sign, no exponent) within Number's safe range. */
function wholeNumber(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

const hashKey = (text: string): string | null => (isHash(text) ? text : null);

/**
 * Opaque cursor: base64url, without padding, of `<created_at>.<key>` of the last row of the page,
 * where the key is the hash (bans) or the row id (checks, log). Rows go newest first, so the next
 * page holds the rows strictly before that position in (created_at, key) order.
 */
const encodeCursor = (createdAt: number, key: string | number): string => b64url(`${createdAt}.${key}`);

function decodeCursor(raw: string, parseKey: (text: string) => string | number | null): After | null {
  let text: string;
  try {
    // Digits, ".", and a-f never produce "-" or "_" in base64url, so plain atob (which accepts a
    // missing padding) decodes every cursor this Worker issues.
    text = atob(raw);
  } catch {
    return null;
  }
  const parts = text.split(".");
  if (parts.length !== 2) return null;
  const createdAt = wholeNumber(parts[0]!);
  const key = parseKey(parts[1]!);
  return createdAt === null || key === null ? null : { createdAt, key };
}

/** `limit` (1 to 100, 50 by default) and `cursor`, common to every listing. */
function pageParams(
  p: Query,
  parseKey: (text: string) => string | number | null,
): { limit: number; after: After | null } | { error: string } {
  const limit = p.limit === undefined ? DEFAULT_LIMIT : wholeNumber(p.limit);
  // Stryker disable next-line ConditionalExpression: `null < 1` is true, so `limit < 1` already rejects null; the check is for TypeScript.
  if (limit === null || limit < 1 || limit > MAX_LIMIT) return { error: "invalid limit" };
  if (p.cursor === undefined) return { limit, after: null };
  const after = decodeCursor(p.cursor, parseKey);
  return after ? { limit, after } : { error: "invalid cursor" };
}

/**
 * The store was asked for `limit + 1` rows: the extra one only says whether there is a next page,
 * and the cursor points at the last row returned.
 */
function page<T extends { created_at: number }>(
  app: string,
  rows: T[],
  limit: number,
  keyOf: (row: T) => string | number,
  item: (row: T) => unknown,
): Response {
  const items = rows.slice(0, limit);
  // With more rows than `limit` (at least 1), the page is full and `last` exists.
  const last = items[limit - 1]!;
  const next = rows.length > limit ? encodeCursor(last.created_at, keyOf(last)) : null;
  return json({ app, items: items.map(item), next_cursor: next });
}

const BAN_REASONS: readonly string[] = ["manual", "propagated"];

export async function listBans(url: URL, env: GuardEnv, store: Store) {
  const p: Query = Object.fromEntries(url.searchParams);
  const config = configuredApp(env, p.app);
  if (config instanceof Response) return config;
  const { app } = config;

  if (p.kind !== undefined && !isKind(p.kind)) return json({ error: "invalid kind" }, 400);
  if (p.reason !== undefined && !BAN_REASONS.includes(p.reason)) return json({ error: "invalid reason" }, 400);
  const params = pageParams(p, hashKey);
  if ("error" in params) return json(params, 400);

  const filters = { kind: p.kind as Kind | undefined, reason: p.reason as BanReason | undefined };
  const rows = await store.listBans(app, filters, params.after, params.limit + 1);
  return page(app, rows, params.limit, (r) => r.hash, (r) => r);
}

export async function listChecks(url: URL, env: GuardEnv, store: Store) {
  const p: Query = Object.fromEntries(url.searchParams);
  const config = configuredApp(env, p.app);
  if (config instanceof Response) return config;
  const { app } = config;

  if (p.ref !== undefined && !isRef(p.ref)) return json({ error: "invalid ref" }, 400);
  if (p.blocked !== undefined && p.blocked !== "0" && p.blocked !== "1") {
    return json({ error: "invalid blocked" }, 400);
  }
  const since = p.since === undefined ? undefined : wholeNumber(p.since);
  if (since === null) return json({ error: "invalid since" }, 400);
  const params = pageParams(p, wholeNumber);
  if ("error" in params) return json(params, 400);

  const blocked = p.blocked === undefined ? undefined : Number(p.blocked);
  const rows = await store.listChecks(app, { ref: p.ref, blocked, since }, params.after, params.limit + 1);
  return page(app, rows, params.limit, (r) => r.id, ({ id: _, ...item }) => item);
}

export async function listAdminLog(url: URL, env: GuardEnv, store: Store) {
  const p: Query = Object.fromEntries(url.searchParams);
  const config = configuredApp(env, p.app);
  if (config instanceof Response) return config;
  const { app } = config;

  const params = pageParams(p, wholeNumber);
  if ("error" in params) return json(params, 400);

  const rows = await store.listAdminLog(app, params.after, params.limit + 1);
  return page(app, rows, params.limit, (r) => r.id, ({ id: _, ...item }) => item);
}
