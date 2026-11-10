import { describe, expect, it } from "vitest";
import type { GuardEnv } from "../src/env";
import worker, { handle } from "../src/index";
import { guardEnv, randomHash, randomIds } from "./helpers";

const DAY_MS = 24 * 3600 * 1000;

const checkRequest = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://guard.test/v1/device/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

const validBody = () => JSON.stringify({ app: "demo", ids: randomIds() });

/** Rate limiter falso: guarda las claves y responde lo que se le diga. */
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

describe("enrutado y respuestas", () => {
  it("todas las respuestas son JSON y no se cachean", async () => {
    const responses = await Promise.all([
      handle(checkRequest(validBody()), guardEnv, () => null),
      handle(checkRequest("{"), guardEnv, () => null),
      handle(new Request("https://guard.test/v1/admin/lookup?app=demo&ref=AAAAAAAA"), guardEnv),
      handle(new Request("https://guard.test/nope"), guardEnv),
    ]);
    for (const res of responses) {
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("cuerpo que no es JSON: 400 bad_request", async () => {
    const res = await handle(checkRequest("no es json"), guardEnv, () => null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("JSON que no cumple el contrato: 400 bad_request", async () => {
    const res = await handle(checkRequest(JSON.stringify({ app: "demo", ids: {} })), guardEnv, () => null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("app sin HASH_PREFIX: 404 unknown_app", async () => {
    const body = JSON.stringify({ app: "nope", ids: randomIds() });
    const res = await handle(checkRequest(body), guardEnv, () => null);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_app" });
  });

  it.each([
    ["ruta desconocida", "GET", "https://guard.test/nope"],
    ["check con GET", "GET", "https://guard.test/v1/device/check"],
    ["prefijo parecido al de admin", "GET", "https://guard.test/v1/adminx/lookup"],
  ])("%s, sin token: 404 not_found (no 401)", async (_name, method, url) => {
    const res = await handle(new Request(url, { method }), guardEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("ruta de admin sin token: 401 unauthorized", async () => {
    const res = await handle(new Request("https://guard.test/v1/admin/nope"), guardEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("el export por defecto atiende fetch con el mismo enrutado", async () => {
    const res = await worker.fetch!(new Request("https://guard.test/nope") as never, guardEnv);
    expect(res.status).toBe(404);
  });
});

describe("rate limit de check", () => {
  it("por encima del límite: 429 antes de leer el cuerpo", async () => {
    const { env, keys } = limiter(false);
    const res = await handle(checkRequest("no es json", { "cf-connecting-ip": "203.0.113.7" }), env, () => null);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(keys).toEqual(["203.0.113.7"]);
  });

  it("dentro del límite: sigue con la comprobación", async () => {
    const { env, keys } = limiter(true);
    const res = await handle(checkRequest(validBody(), { "cf-connecting-ip": "203.0.113.8" }), env, () => null);
    expect(res.status).toBe(200);
    expect(keys).toEqual(["203.0.113.8"]);
  });

  it('sin cf-connecting-ip, la clave es "unknown"', async () => {
    const { env, keys } = limiter(true);
    await handle(checkRequest(validBody()), env, () => null);
    expect(keys).toEqual(["unknown"]);
  });

  it("sin binding RATE_LIMITER: no limita", async () => {
    const env = { ...guardEnv, RATE_LIMITER: undefined } as GuardEnv;
    expect((await handle(checkRequest(validBody()), env, () => null)).status).toBe(200);
  });

  it("no se aplica a las rutas de admin", async () => {
    const { env, keys } = limiter(false);
    const res = await handle(new Request("https://guard.test/v1/admin/lookup?app=demo&ref=AAAAAAAA"), env);
    expect(res.status).toBe(401);
    expect(keys).toEqual([]);
  });
});

describe("cron de purga de check_log", () => {
  it("borra lo de más de 30 días y conserva lo reciente", async () => {
    const ref = randomHash().slice(0, 8).toUpperCase();
    const now = Date.now();
    const insert = guardEnv.DB.prepare(
      "INSERT INTO check_log (app, ref, blocked, matched, bit0, intent, created_at) VALUES ('demo', ?, 0, 0, NULL, ?, ?)",
    );
    await guardEnv.DB.batch([
      insert.bind(ref, "old", now - 31 * DAY_MS),
      insert.bind(ref, "edge", now - 29 * DAY_MS),
      insert.bind(ref, "recent", now - 1000),
    ]);

    await worker.scheduled!({} as never, guardEnv);

    const { results } = await guardEnv.DB.prepare("SELECT intent FROM check_log WHERE ref = ? ORDER BY created_at")
      .bind(ref)
      .all<{ intent: string }>();
    expect(results.map((r) => r.intent)).toEqual(["edge", "recent"]);
  });
});
