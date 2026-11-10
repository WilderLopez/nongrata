// Admin CLI (docs/DESIGN.md, section 9). Wraps the Worker's /v1/admin/* endpoints; the Worker
// computes the hash with the app's prefix. The formula is imported from the Worker so there are
// never two copies: `hash` uses it offline and the tests run the vectors through it. `pair` and
// `devices` manage admin devices (docs/DEVICE-PAIRING.md).

import { hashId, isHash, isKind, isRef, KINDS, refFromInstallHash, type Kind } from "../../worker/src/hash.ts";
import { encodeQr, renderHalfBlocks } from "./qr.ts";

export const USAGE = `Usage:
  nongrata ban    app=<app> kind=<kind> (value=<value> | hash=<hash>) [note=<text>]
  nongrata unban  app=<app> ref=<REF>
  nongrata unban  app=<app> kind=<kind> (value=<value> | hash=<hash>)
  nongrata lookup app=<app> ref=<REF>
  nongrata lookup app=<app> kind=<kind> (value=<value> | hash=<hash>)
  nongrata bans   app=<app> [kind=<kind>] [reason=manual|propagated] [limit=<n>] [cursor=<c>]
  nongrata checks app=<app> [ref=<REF>] [blocked=0|1] [since=<unix ms>] [limit=<n>] [cursor=<c>]
  nongrata log    app=<app> [limit=<n>] [cursor=<c>]
  nongrata hash   prefix=<prefix> kind=<kind> value=<value>    (offline)
  nongrata pair   app=<app> role=read|admin [label=<text>]
  nongrata devices app=<app>
  nongrata devices revoke app=<app> id=<device id>

kind: ${KINDS.join(", ")}
bans, checks and log print one page, newest first (limit 1 to 100, 50 by default); for the next
one, pass its next_cursor as cursor=<c>. checks only covers the last 30 days.
pair shows a QR code for the NonGrata Dashboard app, waits for a device to claim it and asks you
to compare its verification code before approving it. Devices belong to a Worker, not to an app:
in pair and devices, app= only chooses which Worker (its URL and token below).

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
  /** Shows `question` and reads one line from stdin; `null` at the end of the input. */
  ask: (question: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
}

/** How often `pair` asks the Worker whether the device has claimed the pairing. */
export const POLL_MS = 2_000;
/** 11 minutes of polls: the Worker expires a pairing after 10, so this only guards against a stuck Worker. */
export const MAX_POLLS = 330;

type Params = Record<string, string>;

/**
 * `ban app=myapp kind=idfv value=a=b` → `{ command: "ban", params: { app, kind, value: "a=b" } }`.
 * `devices revoke …` is the one command of two words.
 */
export function parseArgs(argv: string[]): { command: string; params: Params } {
  // Stryker disable next-line StringLiteral: run() handles an empty argv before calling this; the default only exists so that command is a string.
  let [command = "", ...rest] = argv;
  if (command === "devices" && rest[0] === "revoke") {
    command = "devices revoke";
    rest = rest.slice(1);
  }
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

function checkKind(kind: string): asserts kind is Kind {
  if (!isKind(kind)) throw new UsageError(`invalid kind: ${kind} (${KINDS.join(", ")})`);
}

/** `{ kind, value }` or `{ kind, hash }`, validated the way the Worker validates it. */
function identifier(params: Params): Params {
  const kind = requireParam(params, "kind");
  checkKind(kind);
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

/** Filters of a listing, as given except `app` (it goes apart) and `kind` and `ref`, checked as above. */
function listing(params: Params, allowed: string[]): Params {
  allowOnly(params, ["app", ...allowed]);
  const { app: _, ...filters } = params;
  if (filters.kind !== undefined) checkKind(filters.kind);
  if (filters.ref !== undefined) filters.ref = ref(params);
  return filters;
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

/** A request to the Worker of `base`, with the token; `payload` goes as the query of a GET or the JSON of a POST. */
function adminRequest(base: URL, token: string, method: string, path: string, payload: Params | null): Request {
  const url = new URL(path, base);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method === "GET" || payload === null) {
    for (const [k, v] of Object.entries(payload ?? {})) url.searchParams.set(k, v);
    return new Request(url, { method, headers });
  }
  headers["content-type"] = "application/json";
  return new Request(url, { method, headers, body: JSON.stringify(payload) });
}

/** A device id: 16 bytes in base64url. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** The HTTP request for an admin command, without sending it. */
export function buildRequest(command: string, params: Params, env: Io["env"]): Request {
  const app = requireParam(params, "app");
  let method: "GET" | "POST";
  let payload: Params | null;
  let path = `/v1/admin/${command}`;

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
    case "bans":
      method = "GET";
      payload = { app, ...listing(params, ["kind", "reason", "limit", "cursor"]) };
      break;
    case "checks":
      method = "GET";
      payload = { app, ...listing(params, ["ref", "blocked", "since", "limit", "cursor"]) };
      break;
    case "log":
      method = "GET";
      payload = { app, ...listing(params, ["limit", "cursor"]) };
      break;
    // Devices belong to the Worker: `app` only picks its URL and token, and is not sent.
    case "devices":
      allowOnly(params, ["app"]);
      method = "GET";
      payload = {};
      break;
    case "devices revoke": {
      allowOnly(params, ["app", "id"]);
      const id = requireParam(params, "id");
      if (!DEVICE_ID_RE.test(id)) throw new UsageError("invalid id: the device_id that devices lists");
      method = "POST";
      payload = null;
      path = `/v1/admin/devices/${id}/revoke`;
      break;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }

  const { url: base, token } = endpoint(app, env);
  return adminRequest(base, token, method, path, payload);
}

/** The JSON pretty-printed, or the text as it came if it is not JSON. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Sends the request; the body of a 2xx, or `null` after printing the error. */
async function send(io: Io, request: Request): Promise<string | null> {
  let response: Response;
  try {
    response = await io.fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    io.err(`nongrata: no response from ${new URL(request.url).origin}: ${(e as Error).message}`);
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    io.err(`nongrata: HTTP ${response.status}\n${pretty(text)}`);
    return null;
  }
  return text;
}

interface PairingStatus {
  status: "pending" | "claimed" | "approved" | "expired";
  device?: { device_id: string; name: string; platform: string; verification_code: string };
}

/**
 * `pair`: creates the pairing, shows it as a QR code and a link, waits for a device to claim it,
 * and approves it only if the admin confirms that the device shows the same code. Anything but
 * "y" or "yes" cancels the pairing, which also deletes the device that claimed it.
 */
async function pair(params: Params, io: Io): Promise<number> {
  allowOnly(params, ["app", "role", "label"]);
  const app = requireParam(params, "app");
  const role = requireParam(params, "role");
  if (role !== "read" && role !== "admin") throw new UsageError("invalid role: read or admin");
  const { url: base, token } = endpoint(app, io.env);
  const call = async (method: string, path: string, payload: Params | null = null) => {
    const text = await send(io, adminRequest(base, token, method, path, payload));
    // Stryker disable next-line ConditionalExpression: JSON.parse(null) is null too.
    return text === null ? null : JSON.parse(text);
  };

  const created = await call("POST", "/v1/admin/pairings", params.label ? { role, label: params.label } : { role });
  if (!created) return 1;
  const { id, pair_url: link } = created as { id: string; pair_url: string };
  const qr = encodeQr(link);
  io.out(
    qr
      ? `Scan with NonGrata Dashboard (expires in 10 min):\n${renderHalfBlocks(qr.modules)}`
      : "The link is too long for a QR code (expires in 10 min).",
  );
  io.out(`Or open: ${link}`);
  // The Worker only makes plain http links for wrangler dev on localhost or 127.0.0.1.
  if (new URL(link).searchParams.get("url")?.startsWith("http:")) {
    io.err("nongrata: warning: this link uses plain http; it is only for wrangler dev on this machine.");
  }
  io.out("Waiting for the device…");

  let state: PairingStatus = { status: "pending" };
  for (let polls = 0; state.status === "pending"; polls++) {
    if (polls === MAX_POLLS) {
      io.err("nongrata: no device claimed the pairing in time. Run pair again.");
      return 1;
    }
    await io.sleep(POLL_MS);
    const next = await call("GET", `/v1/admin/pairings/${id}`);
    if (!next) return 1;
    state = next;
  }
  if (state.status !== "claimed") {
    io.err(`nongrata: the pairing is ${state.status}. Run pair again.`);
    return 1;
  }

  const device = state.device!;
  io.out(`Claimed by "${device.name}" (${device.platform}).`);
  const code = `${device.verification_code.slice(0, 3)} ${device.verification_code.slice(3)}`;
  const answer = await io.ask(`Verification code: ${code}. Does the device show the same code? [y/N] `);
  // `null` (the end of the input) reads as "null": a no.
  if (!/^y(es)?$/i.test(String(answer).trim())) {
    if (!(await call("DELETE", `/v1/admin/pairings/${id}`))) return 1;
    io.err("nongrata: not approved. The pairing was cancelled and that device removed.");
    return 1;
  }
  const approved = await call("POST", `/v1/admin/pairings/${id}/approve`);
  if (!approved) return 1;
  io.out(`Paired: device ${approved.device_id} with role ${approved.role}.`);
  return 0;
}

async function localHash(params: Params): Promise<unknown> {
  allowOnly(params, ["prefix", "kind", "value"]);
  const prefix = requireParam(params, "prefix");
  const kind = requireParam(params, "kind");
  checkKind(kind);
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
    if (command === "pair") return await pair(params, io);
    request = buildRequest(command, params, io.env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`nongrata: ${e.message}\n\n${USAGE}`);
    return 2;
  }

  const text = await send(io, request);
  if (text === null) return 1;
  io.out(pretty(text));
  return 0;
}
