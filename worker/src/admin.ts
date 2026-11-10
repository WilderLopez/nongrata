// Endpoints /v1/admin/* (docs/HANDOFF.md, sección 6.4). Todos exigen Bearer ADMIN_TOKEN.

import { appConfig, isAppId, type AppConfig, type GuardEnv } from "./env";
import { hashId, isHash, isKind, isRef, type Kind } from "./hash";
import { json } from "./http";
import type { Store } from "./store";

export async function isAuthorized(request: Request, env: GuardEnv): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  // Stryker disable next-line StringLiteral: sin cabecera, cualquier valor por defecto sin "Bearer " da given = "".
  const header = request.headers.get("authorization") ?? "";
  // Stryker disable next-line StringLiteral: cambiar el "" final solo importa si ADMIN_TOKEN valiera ese texto.
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Se comparan los digests para que la comparación no dependa de la longitud.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * App con formato válido y configurada en este Worker. Una errata en `app` no puede dar un 200
 * que guarda filas que nadie lee, tampoco con `hash` o `ref`.
 */
function configuredApp(env: GuardEnv, app: unknown): AppConfig | Response {
  if (!isAppId(app)) return json({ error: "app inválida" }, 400);
  return appConfig(env, app) ?? json({ error: "app sin configurar" }, 400);
}

/** Resuelve `{ kind, value }` o `{ kind, hash }` a un hash. `value` se hashea con el prefijo de la app. */
async function resolveId(
  config: AppConfig,
  b: Record<string, unknown>,
): Promise<{ kind: Kind; hash: string } | { error: string } | null> {
  if (b.value === undefined && b.hash === undefined) return null;
  if (!isKind(b.kind)) return { error: "kind inválido" };
  if (isHash(b.hash)) return { kind: b.kind, hash: b.hash };
  if (b.hash !== undefined) return { error: "hash inválido" };
  if (typeof b.value !== "string" || b.value.length === 0) return { error: "value inválido" };
  return { kind: b.kind, hash: await hashId(config.hashPrefix, b.kind, b.value) };
}

// Stryker disable all: redundante; los llamadores rechazan igual lo que no es un objeto con `app` válida.
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
  if (!id) return json({ error: "falta value o hash" }, 400);
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
  if (b.ref !== undefined && !isRef(b.ref)) return json({ error: "ref inválido" }, 400);
  if (!id && b.ref === undefined) return json({ error: "falta value, hash o ref" }, 400);

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
    if (!isRef(p.ref)) return json({ error: "ref inválido" }, 400);
    const [unbanRow, checks] = await Promise.all([
      store.getUnban(app, p.ref),
      store.recentChecks(app, p.ref),
    ]);
    return json({ app, ref: p.ref, unban: unbanRow, checks });
  }

  const id = await resolveId(config, p);
  if (!id) return json({ error: "falta ref, value o hash" }, 400);
  if ("error" in id) return json(id, 400);
  return json({ app, hash: id.hash, banned: await store.getBanned(app, id.hash) });
}
