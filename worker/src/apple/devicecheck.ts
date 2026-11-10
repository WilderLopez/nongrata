import { appleJWT } from "./jwt";

export type AppleEnv = "development" | "production";

export interface TwoBits {
  bit0: boolean;
  bit1: boolean;
}

/**
 * Access to the two bits. The `check` algorithm depends only on this interface,
 * so the tests use an in-memory fake.
 */
export interface DeviceCheckClient {
  /** `null` if Apple fails or rejects the token: the caller decides with D1 alone. */
  query(env: AppleEnv, token: string): Promise<TwoBits | null>;
  /** `false` if the write was not confirmed with a 200. */
  setBit0(env: AppleEnv, token: string, bit0: boolean): Promise<boolean>;
}

const BASE: Record<AppleEnv, string> = {
  development: "https://api.development.devicecheck.apple.com",
  production: "https://api.devicecheck.apple.com",
};

const TIMEOUT_MS = 2500;

/**
 * `fetchImpl` is the tests' injection point. The default wraps the global `fetch` instead of
 * passing it bare, so it does not depend on which `this` it is called with.
 */
export function httpDeviceCheck(
  apple: { teamId: string; keyId: string; p8: string },
  // Stryker disable next-line ArrowFunction: only exercised against the real Apple service.
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
        // 200 with the text body "Bit State Not Found": the bits were never written.
        if (!text.trimStart().startsWith("{")) return { bit0: false, bit1: false };
        const json = JSON.parse(text) as Partial<TwoBits>;
        return { bit0: json.bit0 === true, bit1: json.bit1 === true };
      } catch {
        return null;
      }
    },

    async setBit0(env, token, bit0) {
      try {
        // `bit1` is optional in update_two_bits: omitting it leaves it unchanged.
        const res = await post(env, "/v1/update_two_bits", { device_token: token, bit0 });
        await res.body?.cancel();
        return res.status === 200;
      } catch {
        return false;
      }
    },
  };
}
