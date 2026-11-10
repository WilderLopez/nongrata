import * as admin from "./admin";
import { httpDeviceCheck, type DeviceCheckClient } from "./apple/devicecheck";
import { parseCheckRequest, runCheck } from "./check";
import * as devices from "./devices";
import type { Access, Caller } from "./devices";
import { appConfig, type AppConfig, type GuardEnv } from "./env";
import { json } from "./http";
import { Store } from "./store";

const CHECK_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000;

interface AdminContext {
  request: Request;
  url: URL;
  env: GuardEnv;
  store: Store;
  now: number;
  caller: Caller;
  /** The `{id}` of the routes that have one. */
  id?: string;
}

interface AdminRoute {
  access: Access;
  run: (c: AdminContext) => Promise<Response> | Response;
}

const actor = (c: AdminContext) => devices.actorOf(c.caller);

/** Who may call each route: docs/DEVICE-PAIRING.md, section 4. */
const ADMIN_ROUTES = new Map<string, AdminRoute>([
  ["POST /v1/admin/ban", { access: "admin", run: (c) => admin.ban(c.request, c.env, c.store, actor(c), c.now) }],
  ["POST /v1/admin/unban", { access: "admin", run: (c) => admin.unban(c.request, c.env, c.store, actor(c), c.now) }],
  ["GET /v1/admin/lookup", { access: "read", run: (c) => admin.lookup(c.url, c.env, c.store) }],
  ["GET /v1/admin/bans", { access: "read", run: (c) => admin.listBans(c.url, c.env, c.store) }],
  ["GET /v1/admin/checks", { access: "read", run: (c) => admin.listChecks(c.url, c.env, c.store) }],
  ["GET /v1/admin/log", { access: "read", run: (c) => admin.listAdminLog(c.url, c.env, c.store) }],
  ["GET /v1/admin/apps", { access: "read", run: (c) => devices.apps(c.env) }],
  // `allows` lets only devices reach `me`, and pending devices nothing else.
  ["GET /v1/admin/me", { access: "me", run: (c) => devices.me(c.caller as Caller & { kind: "device" }) }],
  ["GET /v1/admin/devices", { access: "admin", run: (c) => devices.listDevices(c.store) }],
  ["POST /v1/admin/pairings", { access: "token", run: (c) => devices.createPairing(c.request, c.url, c.store, c.now) }],
]);

/** Routes with an `{id}` segment. */
const ADMIN_ID_ROUTES: [string, RegExp, AdminRoute][] = [
  ["GET", /^\/v1\/admin\/pairings\/([^/]+)$/, { access: "token", run: (c) => devices.getPairing(c.id!, c.store, c.now) }],
  ["DELETE", /^\/v1\/admin\/pairings\/([^/]+)$/, { access: "token", run: (c) => devices.cancelPairing(c.id!, c.store) }],
  [
    "POST",
    /^\/v1\/admin\/pairings\/([^/]+)\/approve$/,
    { access: "token", run: (c) => devices.approvePairing(c.id!, c.store, c.caller, c.now) },
  ],
  [
    "POST",
    /^\/v1\/admin\/devices\/([^/]+)\/revoke$/,
    { access: "revoke", run: (c) => devices.revokeDevice(c.id!, c.store, c.caller, c.now) },
  ],
];

function adminRoute(method: string, path: string): { route: AdminRoute; id?: string } | null {
  const fixed = ADMIN_ROUTES.get(`${method} ${path}`);
  if (fixed) return { route: fixed };
  for (const [m, pattern, route] of ADMIN_ID_ROUTES) {
    const match = method === m ? pattern.exec(path) : null;
    if (match) return { route, id: match[1]! };
  }
  return null;
}

/** The RATE_LIMITER binding, per client IP: a 429 if over the limit, `null` to go on. */
async function rateLimited(request: Request, env: GuardEnv): Promise<Response | null> {
  if (!env.RATE_LIMITER) return null;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key });
  return success ? null : json({ error: "rate_limited" }, 429);
}

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
    const limited = await rateLimited(request, env);
    if (limited) return limited;

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

  if (route === "POST /v1/pair/claim") {
    const limited = await rateLimited(request, env);
    if (limited) return limited;
    return devices.claim(request, store, now);
  }

  if (url.pathname.startsWith("/v1/admin/")) {
    // Authentication first, so an unknown route gives 401 to whoever is not authenticated.
    const match = adminRoute(request.method, url.pathname);
    const caller = await devices.authenticate(request, url, env, store, now);
    if (caller instanceof Response) return caller;
    if (!match) return json({ error: "not_found" }, 404);
    if (!devices.allows(caller, match.route.access, match.id)) return json({ error: "forbidden" }, 403);
    await devices.touch(caller, store, now);
    return match.route.run({ request, url, env, store, now, caller, id: match.id });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  fetch: (request, env) => handle(request, env),

  async scheduled(_controller, env) {
    const store = new Store(env.DB);
    const now = Date.now();
    await store.purgeCheckLog(now - CHECK_LOG_RETENTION_MS);
    await store.purgeAdminAuth(now, devices.MAX_FAILED_CLAIMS);
  },
} satisfies ExportedHandler<GuardEnv>;
