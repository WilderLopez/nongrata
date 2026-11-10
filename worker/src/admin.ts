// /v1/admin/* endpoints (docs/HANDOFF.md, section 6.4). All of them require Bearer ADMIN_TOKEN.

import { appConfig, isAppId, type AppConfig, type GuardEnv } from "./env";
import { hashId, isHash, isKind, isRef, type Kind } from "./hash";
import { json } from "./http";
import type { Store } from "./store";

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

  const result: Record<string, unknown> = { app };
  if (id) {
    result.hash = id.hash;
    result.removed = await store.unbanHash(app, id.hash);
  }
  if (isRef(b.ref)) {
    await store.scheduleUnban(app, b.ref, now);
    result.ref = b.ref;
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
