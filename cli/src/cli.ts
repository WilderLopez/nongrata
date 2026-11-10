// Admin CLI (docs/DESIGN.md, section 9). Wraps the Worker's /v1/admin/* endpoints; the Worker
// computes the hash with the app's prefix. The formula is imported from the Worker so there are
// never two copies: `hash` uses it offline and the tests run the vectors through it.

import { hashId, isHash, isKind, isRef, KINDS, refFromInstallHash } from "../../worker/src/hash.ts";

export const USAGE = `Usage:
  nongrata ban    app=<app> kind=<kind> (value=<value> | hash=<hash>) [note=<text>]
  nongrata unban  app=<app> ref=<REF>
  nongrata unban  app=<app> kind=<kind> (value=<value> | hash=<hash>)
  nongrata lookup app=<app> ref=<REF>
  nongrata lookup app=<app> kind=<kind> (value=<value> | hash=<hash>)
  nongrata hash   prefix=<prefix> kind=<kind> value=<value>    (offline)

kind: ${KINDS.join(", ")}

Environment (the suffix is the app in uppercase, with "-" as "_"; it wins over the generic one):
  NONGRATA_URL_<APP>          or NONGRATA_URL           URL of that app's Worker
  NONGRATA_ADMIN_TOKEN_<APP>  or NONGRATA_ADMIN_TOKEN   ADMIN_TOKEN of that Worker`;

const TIMEOUT_MS = 15_000;

export class UsageError extends Error {}

export interface Io {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (text: string) => void;
  err: (text: string) => void;
}

type Params = Record<string, string>;

/** `ban app=myapp kind=idfv value=a=b` → `{ command: "ban", params: { app, kind, value: "a=b" } }`. */
export function parseArgs(argv: string[]): { command: string; params: Params } {
  // Stryker disable next-line StringLiteral: run() handles an empty argv before calling this; the default only exists so that command is a string.
  const [command = "", ...rest] = argv;
  // No prototype: `constructor=` or `__proto__=` are parameters like any other, not inherited ones.
  const params: Params = Object.create(null);
  for (const arg of rest) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new UsageError(`argument not in key=value form: ${arg}`);
    const key = arg.slice(0, eq);
    if (key in params) throw new UsageError(`duplicate parameter: ${key}`);
    params[key] = arg.slice(eq + 1);
  }
  return { command, params };
}

function allowOnly(params: Params, allowed: string[]): void {
  const unknown = Object.keys(params).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new UsageError(`unknown parameter: ${unknown.join(", ")}`);
}

function requireParam(params: Params, key: string): string {
  const v = params[key];
  if (!v) throw new UsageError(`missing ${key}`);
  return v;
}

/** `{ kind, value }` or `{ kind, hash }`, validated the way the Worker validates it. */
function identifier(params: Params): Params {
  const kind = requireParam(params, "kind");
  if (!isKind(kind)) throw new UsageError(`invalid kind: ${kind} (${KINDS.join(", ")})`);
  const { value, hash } = params;
  if ((value === undefined) === (hash === undefined)) throw new UsageError("give value or hash, not both");
  if (hash !== undefined) {
    if (!isHash(hash)) throw new UsageError("invalid hash: 64 lowercase hex characters");
    return { kind, hash };
  }
  if (!value) throw new UsageError("empty value");
  return { kind, value };
}

/** The user reads the `ref` out to support, so lowercase is accepted. */
function ref(params: Params): string {
  const r = params.ref!.toUpperCase();
  if (!isRef(r)) throw new UsageError("invalid ref: 8 hex characters");
  return r;
}

/** `ref=` or `kind` + `value`/`hash`, never both (so as not to do two things by mistake). */
function refOrIdentifier(params: Params): Params {
  if (params.ref === undefined) return identifier(params);
  allowOnly(params, ["app", "ref"]);
  return { ref: ref(params) };
}

export function endpoint(app: string, env: Io["env"]): { url: URL; token: string } {
  const suffix = app.toUpperCase().replace(/-/g, "_");
  const rawUrl = env[`NONGRATA_URL_${suffix}`] || env.NONGRATA_URL;
  const token = env[`NONGRATA_ADMIN_TOKEN_${suffix}`] || env.NONGRATA_ADMIN_TOKEN;
  if (!rawUrl) throw new UsageError(`missing NONGRATA_URL_${suffix} or NONGRATA_URL`);
  if (!token) throw new UsageError(`missing NONGRATA_ADMIN_TOKEN_${suffix} or NONGRATA_ADMIN_TOKEN`);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UsageError(`invalid URL: ${rawUrl}`);
  }
  // The token travels in a header: in cleartext only towards `wrangler dev`.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new UsageError("the URL must be https (http only for localhost)");
  }
  return { url, token };
}

/** The HTTP request for an admin command, without sending it. */
export function buildRequest(command: string, params: Params, env: Io["env"]): Request {
  const app = requireParam(params, "app");
  let method: "GET" | "POST";
  let payload: Params;

  switch (command) {
    case "ban":
      allowOnly(params, ["app", "kind", "value", "hash", "note"]);
      method = "POST";
      payload = { app, ...identifier(params) };
      if (params.note) payload.note = params.note;
      break;
    case "unban":
      allowOnly(params, ["app", "ref", "kind", "value", "hash"]);
      method = "POST";
      payload = { app, ...refOrIdentifier(params) };
      break;
    case "lookup":
      allowOnly(params, ["app", "ref", "kind", "value", "hash"]);
      method = "GET";
      payload = { app, ...refOrIdentifier(params) };
      break;
    default:
      throw new UsageError(`unknown command: ${command}`);
  }

  const { url: base, token } = endpoint(app, env);
  const url = new URL(`/v1/admin/${command}`, base);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "GET") {
    for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, v);
    return new Request(url, { method, headers });
  }
  headers["content-type"] = "application/json";
  return new Request(url, { method, headers, body: JSON.stringify(payload) });
}

async function localHash(params: Params): Promise<unknown> {
  allowOnly(params, ["prefix", "kind", "value"]);
  const prefix = requireParam(params, "prefix");
  const kind = requireParam(params, "kind");
  if (!isKind(kind)) throw new UsageError(`invalid kind: ${kind} (${KINDS.join(", ")})`);
  const hash = await hashId(prefix, kind, requireParam(params, "value"));
  return kind === "install" ? { kind, hash, ref: refFromInstallHash(hash) } : { kind, hash };
}

/** Returns the exit code: 0 success, 1 Worker or network error, 2 incorrect usage. */
export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0 || ["help", "-h", "--help"].includes(argv[0]!)) {
    (argv.length === 0 ? io.err : io.out)(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  let request: Request;
  try {
    const { command, params } = parseArgs(argv);
    if (command === "hash") {
      io.out(JSON.stringify(await localHash(params), null, 2));
      return 0;
    }
    request = buildRequest(command, params, io.env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`nongrata: ${e.message}\n\n${USAGE}`);
    return 2;
  }

  let response: Response;
  try {
    response = await io.fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    io.err(`nongrata: no response from ${new URL(request.url).origin}: ${(e as Error).message}`);
    return 1;
  }

  const text = await response.text();
  let body: string;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    body = text;
  }
  if (!response.ok) {
    io.err(`nongrata: HTTP ${response.status}\n${body}`);
    return 1;
  }
  io.out(body);
  return 0;
}
