// CLI de administración (docs/HANDOFF.md, sección 9). Envuelve los endpoints /v1/admin/* del
// Worker; el hash lo calcula el Worker con el prefijo de la app. La fórmula se importa del
// Worker para que no haya dos copias: `hash` la usa sin red y los tests pasan los vectores.

import { hashId, isHash, isKind, isRef, KINDS, refFromInstallHash } from "../../worker/src/hash.ts";

export const USAGE = `Uso:
  nongrata ban    app=<app> kind=<kind> (value=<valor> | hash=<hash>) [note=<texto>]
  nongrata unban  app=<app> ref=<REF>
  nongrata unban  app=<app> kind=<kind> (value=<valor> | hash=<hash>)
  nongrata lookup app=<app> ref=<REF>
  nongrata lookup app=<app> kind=<kind> (value=<valor> | hash=<hash>)
  nongrata hash   prefix=<prefijo> kind=<kind> value=<valor>    (sin red)

kind: ${KINDS.join(", ")}

Entorno (el sufijo es la app en mayúsculas, con "-" como "_"; tiene prioridad sobre el genérico):
  NONGRATA_URL_<APP>          o NONGRATA_URL           URL del Worker de esa app
  NONGRATA_ADMIN_TOKEN_<APP>  o NONGRATA_ADMIN_TOKEN   ADMIN_TOKEN de ese Worker`;

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
  // Stryker disable next-line StringLiteral: run() atiende argv vacío antes de llamar aquí; el valor por defecto solo existe para que command sea string.
  const [command = "", ...rest] = argv;
  // Sin prototipo: `constructor=` o `__proto__=` son parámetros como cualquier otro, no heredados.
  const params: Params = Object.create(null);
  for (const arg of rest) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new UsageError(`argumento sin formato clave=valor: ${arg}`);
    const key = arg.slice(0, eq);
    if (key in params) throw new UsageError(`${key} repetido`);
    params[key] = arg.slice(eq + 1);
  }
  return { command, params };
}

function allowOnly(params: Params, allowed: string[]): void {
  const unknown = Object.keys(params).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new UsageError(`parámetro desconocido: ${unknown.join(", ")}`);
}

function requireParam(params: Params, key: string): string {
  const v = params[key];
  if (!v) throw new UsageError(`falta ${key}`);
  return v;
}

/** `{ kind, value }` o `{ kind, hash }`, validado como lo valida el Worker. */
function identifier(params: Params): Params {
  const kind = requireParam(params, "kind");
  if (!isKind(kind)) throw new UsageError(`kind inválido: ${kind} (${KINDS.join(", ")})`);
  const { value, hash } = params;
  if ((value === undefined) === (hash === undefined)) throw new UsageError("indica value o hash, no ambos");
  if (hash !== undefined) {
    if (!isHash(hash)) throw new UsageError("hash inválido: 64 caracteres hex en minúsculas");
    return { kind, hash };
  }
  if (!value) throw new UsageError("value vacío");
  return { kind, value };
}

/** El `ref` lo dicta el usuario a soporte; se aceptan minúsculas. */
function ref(params: Params): string {
  const r = params.ref!.toUpperCase();
  if (!isRef(r)) throw new UsageError("ref inválido: 8 caracteres hex");
  return r;
}

/** `ref=` o `kind` + `value`/`hash`, nunca los dos (para no hacer dos cosas por error). */
function refOrIdentifier(params: Params): Params {
  if (params.ref === undefined) return identifier(params);
  allowOnly(params, ["app", "ref"]);
  return { ref: ref(params) };
}

export function endpoint(app: string, env: Io["env"]): { url: URL; token: string } {
  const suffix = app.toUpperCase().replace(/-/g, "_");
  const rawUrl = env[`NONGRATA_URL_${suffix}`] || env.NONGRATA_URL;
  const token = env[`NONGRATA_ADMIN_TOKEN_${suffix}`] || env.NONGRATA_ADMIN_TOKEN;
  if (!rawUrl) throw new UsageError(`falta NONGRATA_URL_${suffix} o NONGRATA_URL`);
  if (!token) throw new UsageError(`falta NONGRATA_ADMIN_TOKEN_${suffix} o NONGRATA_ADMIN_TOKEN`);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UsageError(`URL inválida: ${rawUrl}`);
  }
  // El token viaja en la cabecera: en claro solo hacia `wrangler dev`.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new UsageError("la URL debe ser https (http solo para localhost)");
  }
  return { url, token };
}

/** Petición HTTP de un comando de administración, sin enviarla. */
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
      throw new UsageError(`comando desconocido: ${command}`);
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
  if (!isKind(kind)) throw new UsageError(`kind inválido: ${kind} (${KINDS.join(", ")})`);
  const hash = await hashId(prefix, kind, requireParam(params, "value"));
  return kind === "install" ? { kind, hash, ref: refFromInstallHash(hash) } : { kind, hash };
}

/** Devuelve el código de salida: 0 bien, 1 error del Worker o de red, 2 uso incorrecto. */
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
    io.err(`nongrata: sin respuesta de ${new URL(request.url).origin}: ${(e as Error).message}`);
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
