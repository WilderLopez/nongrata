import * as admin from "./admin";
import { httpDeviceCheck, type DeviceCheckClient } from "./apple/devicecheck";
import { parseCheckRequest, runCheck } from "./check";
import { appConfig, type AppConfig, type GuardEnv } from "./env";
import { json } from "./http";
import { Store } from "./store";

const CHECK_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Injection point for the tests: replaces the Apple HTTP client. */
export type DeviceCheckFactory = (config: AppConfig) => DeviceCheckClient | null;

// Stryker disable next-line ArrowFunction: only exercised against the real Apple service.
const defaultDeviceCheck: DeviceCheckFactory = (config) =>
  config.apple ? httpDeviceCheck(config.apple) : null;

export async function handle(
  request: Request,
  env: GuardEnv,
  makeDeviceCheck: DeviceCheckFactory = defaultDeviceCheck,
): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  const store = new Store(env.DB);
  const now = Date.now();

  if (route === "POST /v1/device/check") {
    if (env.RATE_LIMITER) {
      const key = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) return json({ error: "rate_limited" }, 429);
    }

    let body: unknown;
    // Stryker disable BlockStatement: emptying the catch leaves body undefined and parseCheckRequest returns the same 400.
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    // Stryker restore BlockStatement
    const req = parseCheckRequest(body);
    if (!req) return json({ error: "bad_request" }, 400);
    const config = appConfig(env, req.app);
    if (!config) return json({ error: "unknown_app" }, 404);

    const result = await runCheck(req, config, {
      store,
      deviceCheck: makeDeviceCheck(config),
      now,
    });
    return json(result);
  }

  if (url.pathname.startsWith("/v1/admin/")) {
    if (!(await admin.isAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
    switch (route) {
      case "POST /v1/admin/ban":
        return admin.ban(request, env, store, now);
      case "POST /v1/admin/unban":
        return admin.unban(request, env, store, now);
      case "GET /v1/admin/lookup":
        return admin.lookup(url, env, store);
      case "GET /v1/admin/bans":
        return admin.listBans(url, env, store);
      case "GET /v1/admin/checks":
        return admin.listChecks(url, env, store);
      case "GET /v1/admin/log":
        return admin.listAdminLog(url, env, store);
    }
  }

  return json({ error: "not_found" }, 404);
}

export default {
  fetch: (request, env) => handle(request, env),

  async scheduled(_controller, env) {
    await new Store(env.DB).purgeCheckLog(Date.now() - CHECK_LOG_RETENTION_MS);
  },
} satisfies ExportedHandler<GuardEnv>;
