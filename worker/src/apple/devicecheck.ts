import { appleJWT } from "./jwt";

export type AppleEnv = "development" | "production";

export interface TwoBits {
  bit0: boolean;
  bit1: boolean;
}

/**
 * Acceso a los two bits. El algoritmo de `check` solo depende de esta interfaz,
 * así que los tests usan un falso en memoria.
 */
export interface DeviceCheckClient {
  /** `null` si Apple falla o rechaza el token: el llamador decide solo con D1. */
  query(env: AppleEnv, token: string): Promise<TwoBits | null>;
  /** `false` si la escritura no se confirmó con un 200. */
  setBit0(env: AppleEnv, token: string, bit0: boolean): Promise<boolean>;
}

const BASE: Record<AppleEnv, string> = {
  development: "https://api.development.devicecheck.apple.com",
  production: "https://api.devicecheck.apple.com",
};

const TIMEOUT_MS = 2500;

/**
 * `fetchImpl` es el punto de inyección de los tests. El valor por defecto envuelve al `fetch`
 * global en vez de pasarlo suelto, para no depender de con qué `this` se le llame.
 */
export function httpDeviceCheck(
  apple: { teamId: string; keyId: string; p8: string },
  // Stryker disable next-line ArrowFunction: solo se ejercita contra Apple de verdad.
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): DeviceCheckClient {
  const post = async (env: AppleEnv, path: string, body: Record<string, unknown>) =>
    fetchImpl(`${BASE[env]}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await appleJWT(apple)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        transaction_id: crypto.randomUUID(),
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return {
    async query(env, token) {
      try {
        const res = await post(env, "/v1/query_two_bits", { device_token: token });
        const text = await res.text();
        if (res.status !== 200) return null;
        // 200 con cuerpo de texto "Bit State Not Found": nunca se escribieron.
        if (!text.trimStart().startsWith("{")) return { bit0: false, bit1: false };
        const json = JSON.parse(text) as Partial<TwoBits>;
        return { bit0: json.bit0 === true, bit1: json.bit1 === true };
      } catch {
        return null;
      }
    },

    async setBit0(env, token, bit0) {
      try {
        // `bit1` es opcional en update_two_bits: omitirlo no lo modifica.
        const res = await post(env, "/v1/update_two_bits", { device_token: token, bit0 });
        await res.body?.cancel();
        return res.status === 200;
      } catch {
        return false;
      }
    },
  };
}
