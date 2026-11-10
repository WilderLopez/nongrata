import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { httpDeviceCheck } from "../src/apple/devicecheck";

const APPLE = { p8: env.APPLE_DC_KEY_P8_DEMO, keyId: "KEY0000000", teamId: "TEAM000000" };

interface Sent {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

/** `fetch` falso: guarda cada petición y responde con `reply()`, que puede lanzar. */
function fakeApple(reply: () => Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    });
    return reply();
  }) as typeof fetch;
  return { client: httpDeviceCheck(APPLE, fetchImpl), sent };
}

const text = (body: string, status = 200) => new Response(body, { status });

describe("cliente HTTP de DeviceCheck", () => {
  it.each([
    ["development", "https://api.development.devicecheck.apple.com/v1/query_two_bits"],
    ["production", "https://api.devicecheck.apple.com/v1/query_two_bits"],
  ] as const)("query en %s: endpoint, JWT y cuerpo", async (appleEnv, url) => {
    const { client, sent } = fakeApple(() => Response.json({ bit0: true, bit1: false }));
    const before = Date.now();
    await client.query(appleEnv, "tok-q");

    const [req] = sent;
    expect(req!.url).toBe(url);
    expect(req!.method).toBe("POST");
    expect(req!.headers.get("content-type")).toBe("application/json");
    expect(req!.headers.get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(req!.signal).toBeInstanceOf(AbortSignal);
    expect(req!.body).toEqual({
      device_token: "tok-q",
      transaction_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      timestamp: expect.any(Number),
    });
    // Milisegundos, no segundos.
    expect(req!.body.timestamp).toBeGreaterThanOrEqual(before);
    expect(req!.body.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("cada llamada lleva un transaction_id nuevo", async () => {
    const { client, sent } = fakeApple(() => Response.json({ bit0: false, bit1: false }));
    await client.query("production", "a");
    await client.query("production", "b");
    expect(sent[0]!.body.transaction_id).not.toBe(sent[1]!.body.transaction_id);
  });

  it.each([
    ["bits leídos", Response.json({ bit0: true, bit1: true }), { bit0: true, bit1: true }],
    ["solo bit0", Response.json({ bit0: true, bit1: false }), { bit0: true, bit1: false }],
    ["solo bit1", Response.json({ bit0: false, bit1: true }), { bit0: false, bit1: true }],
    ["JSON precedido de espacios", text('  \n{"bit0":true,"bit1":false}'), { bit0: true, bit1: false }],
    ["bits ausentes en el JSON", Response.json({ last_update_time: "2026-10" }), { bit0: false, bit1: false }],
    ["valores no booleanos", Response.json({ bit0: 1, bit1: "true" }), { bit0: false, bit1: false }],
    ["Bit State Not Found (nunca se escribieron)", text("Bit State Not Found"), { bit0: false, bit1: false }],
  ])("query con 200: %s", async (_name, response, expected) => {
    const { client } = fakeApple(() => response.clone());
    expect(await client.query("production", "tok")).toEqual(expected);
  });

  it.each([
    ["token rechazado (400)", () => text("Missing or badly formatted authorization token", 400)],
    ["JWT rechazado (401)", () => text("Unable to verify authorization token", 401)],
    ["Apple caída (500)", () => text("", 500)],
    ["200 con JSON roto", () => text("{bit0:")],
    [
      "sin respuesta (timeout o red)",
      () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      },
    ],
  ])("query devuelve null: %s", async (_name, reply) => {
    const { client } = fakeApple(reply);
    expect(await client.query("production", "tok")).toBeNull();
  });

  it.each([true, false])("setBit0(%s): manda solo bit0, sin tocar bit1", async (bit0) => {
    const { client, sent } = fakeApple(() => text(""));
    expect(await client.setBit0("development", "tok-u", bit0)).toBe(true);

    const [req] = sent;
    expect(req!.url).toBe("https://api.development.devicecheck.apple.com/v1/update_two_bits");
    expect(req!.method).toBe("POST");
    expect(req!.headers.get("authorization")).toMatch(/^Bearer /);
    expect(req!.body).toEqual({
      device_token: "tok-u",
      bit0,
      transaction_id: expect.any(String),
      timestamp: expect.any(Number),
    });
    expect(req!.body).not.toHaveProperty("bit1");
  });

  it("setBit0 con 200 sin cuerpo: confirmado", async () => {
    const { client } = fakeApple(() => new Response(null, { status: 200 }));
    expect(await client.setBit0("production", "tok", true)).toBe(true);
  });

  it.each([
    ["400", () => text("Missing or incorrectly formatted device token payload", 400)],
    ["500", () => text("", 500)],
    [
      "sin respuesta",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("setBit0 no confirmado (%s): false", async (_name, reply) => {
    const { client } = fakeApple(reply);
    expect(await client.setBit0("production", "tok", true)).toBe(false);
  });
});
