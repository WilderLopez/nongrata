// POST /v1/device/check (docs/HANDOFF.md, sección 6.1).

import type { AppleEnv, DeviceCheckClient, TwoBits } from "./apple/devicecheck";
import type { AppConfig } from "./env";
import { isAppId } from "./env";
import { isHash, refFromInstallHash, type Kind } from "./hash";
import type { IdHash, Store } from "./store";

export const INTENTS = ["launch", "foreground", "login", "signup"] as const;
export type Intent = (typeof INTENTS)[number];

export interface CheckRequest {
  app: string;
  env: AppleEnv;
  /** Token para query_two_bits. */
  dcToken: string | null;
  /**
   * Segundo token para update_two_bits. Apple pide no reutilizar un token, así que el SDK
   * genera dos. Si falta, no se escribe en Apple: se reintenta en la siguiente comprobación.
   */
  dcTokenUpdate: string | null;
  ids: IdHash[];
  ref: string;
  intent: Intent;
}

export interface CheckResult {
  status: "ok" | "blocked";
  ref: string;
}

const TOKEN_RE = /^[A-Za-z0-9+/=_-]{16,8192}$/;
const ID_KINDS: readonly Kind[] = ["idfv", "install", "icloud", "user"];

const optionalToken = (v: unknown): string | null | undefined =>
  v === undefined || v === null ? null : typeof v === "string" && TOKEN_RE.test(v) ? v : undefined;

/** Valida el cuerpo. Devuelve `null` si no es válido. El `ref` se deriva aquí, no se confía en el cliente. */
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
  const ids: IdHash[] = [];
  for (const kind of ID_KINDS) {
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
    ref: refFromInstallHash(install.hash),
    intent: intent as Intent,
  };
}

export interface CheckDeps {
  store: Store;
  /** `null` si la app no tiene clave de DeviceCheck. */
  deviceCheck: DeviceCheckClient | null;
  now: number;
}

export async function runCheck(
  req: CheckRequest,
  config: AppConfig,
  { store, deviceCheck, now }: CheckDeps,
): Promise<CheckResult> {
  const { app, ref } = req;
  const dc = deviceCheck && req.dcToken ? deviceCheck : null;
  // Sin segundo token no se escribe: reutilizar el de la consulta va contra lo que pide Apple.
  const updateToken = req.dcTokenUpdate;

  const [matched, unban, bits] = await Promise.all([
    store.anyBanned(app, req.ids.map((id) => id.hash)),
    store.pendingUnban(app, ref),
    dc ? dc.query(req.env, req.dcToken!) : Promise.resolve<TwoBits | null>(null),
  ]);

  const log = (blocked: boolean, bit0: boolean | null) =>
    store.logCheck(app, { ref, blocked, matched, bit0, intent: req.intent }, now);

  if (unban) {
    // Desbaneo completo: bit0 a false y fuera los hashes que trae este dispositivo, que el
    // administrador no puede deducir del ref. Solo se consume si el bit quedó limpio; si Apple
    // falla o la petición llega sin alguno de los dos tokens, deja entrar y se reintenta en la
    // siguiente comprobación (consumirlo dejaría bit0 activo y el dispositivo volvería a quedar
    // bloqueado). Sin clave de Apple no hay bit que limpiar: se consume solo con D1.
    const cleared = deviceCheck ? (dc && updateToken ? await dc.setBit0(req.env, updateToken, false) : false) : true;
    if (cleared) {
      await store.removeHashes(app, req.ids.map((id) => id.hash));
      await store.consumeUnban(app, ref, now);
    }
    await log(false, cleared && dc ? false : (bits?.bit0 ?? null));
    return { status: "ok", ref };
  }

  const blocked = matched || bits?.bit0 === true;

  // Modo observación (sin ENFORCE): solo se registra el veredicto. Ni se escribe en Apple ni se
  // propaga, para que un baneo erróneo durante la observación no deje huella. Al activar
  // ENFORCE, la primera comprobación de cada dispositivo bloqueado hace las dos cosas.
  if (config.enforce) {
    if (matched && dc && updateToken && bits && !bits.bit0) {
      await dc.setBit0(req.env, updateToken, true);
    }
    // Propagación: un dispositivo bloqueado marca todos sus identificadores, así el bloqueo
    // salta a otros dispositivos con la misma cuenta de iCloud. No pisa las filas existentes.
    if (blocked) {
      await store.insertPropagated(app, req.ids, now);
    }
  }

  await log(blocked, bits?.bit0 ?? null);

  return { status: blocked && config.enforce ? "blocked" : "ok", ref };
}
