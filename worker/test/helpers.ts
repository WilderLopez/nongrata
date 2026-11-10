import { env } from "cloudflare:workers";
import type { AppleEnv, DeviceCheckClient, TwoBits } from "../src/apple/devicecheck";
import type { GuardEnv } from "../src/env";
import { handle } from "../src/index";

export const guardEnv = env as unknown as GuardEnv;

export const randomHash = (): string =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const randomIds = () => ({
  idfv: randomHash(),
  install: randomHash(),
  icloud: randomHash(),
  user: null as string | null,
});

/** Un dispositivo con sus two bits en "Apple". `failing` simula 5xx/timeout. */
export class FakeDeviceCheck implements DeviceCheckClient {
  bits: TwoBits | null = null; // null = Bit State Not Found
  failing = false;
  calls: { op: "query" | "setBit0"; env: AppleEnv; token: string; bit0?: boolean }[] = [];

  constructor(initial?: Partial<TwoBits>) {
    if (initial) this.bits = { bit0: false, bit1: false, ...initial };
  }

  async query(env: AppleEnv, token: string) {
    this.calls.push({ op: "query", env, token });
    if (this.failing) return null;
    return this.bits ? { ...this.bits } : { bit0: false, bit1: false };
  }

  async setBit0(env: AppleEnv, token: string, bit0: boolean) {
    this.calls.push({ op: "setBit0", env, token, bit0 });
    if (this.failing) return false;
    this.bits = { bit0, bit1: this.bits?.bit1 ?? false };
    return true;
  }

  writes() {
    return this.calls.filter((c) => c.op === "setBit0");
  }
}

export interface CheckBody {
  app?: string;
  dc_token?: string | null;
  dc_token_update?: string | null;
  env?: string;
  ids: Record<string, string | null>;
  intent?: string;
}

export async function check(body: CheckBody, dc: FakeDeviceCheck | null = null) {
  const res = await handle(
    new Request("https://guard.test/v1/device/check", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ app: "demo", platform: "ios", app_version: "1.0.0", ...body }),
    }),
    guardEnv,
    () => dc,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function adminCall(
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
  token: string | null = "test-admin-token",
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const url = new URL(`https://guard.test${path}`);
  if (method === "GET" && payload) {
    for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, String(v));
  }
  const res = await handle(
    new Request(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
    }),
    guardEnv,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function logRows(app: string, ref: string) {
  const { results } = await guardEnv.DB.prepare(
    "SELECT blocked, matched, bit0, intent FROM check_log WHERE app = ? AND ref = ? ORDER BY rowid",
  )
    .bind(app, ref)
    .all();
  return results;
}
