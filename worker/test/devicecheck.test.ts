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

/** Fake `fetch`: records each request and responds with `reply()`, which may throw. */
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

describe("DeviceCheck HTTP client", () => {
  it.each([
    ["development", "https://api.development.devicecheck.apple.com/v1/query_two_bits"],
    ["production", "https://api.devicecheck.apple.com/v1/query_two_bits"],
  ] as const)("query in %s: endpoint, JWT and body", async (appleEnv, url) => {
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
    // Milliseconds, not seconds.
    expect(req!.body.timestamp).toBeGreaterThanOrEqual(before);
    expect(req!.body.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("each call carries a new transaction_id", async () => {
    const { client, sent } = fakeApple(() => Response.json({ bit0: false, bit1: false }));
    await client.query("production", "a");
    await client.query("production", "b");
    expect(sent[0]!.body.transaction_id).not.toBe(sent[1]!.body.transaction_id);
  });

  it.each([
    ["bits read", Response.json({ bit0: true, bit1: true }), { bit0: true, bit1: true }],
    ["only bit0", Response.json({ bit0: true, bit1: false }), { bit0: true, bit1: false }],
    ["only bit1", Response.json({ bit0: false, bit1: true }), { bit0: false, bit1: true }],
    ["JSON preceded by whitespace", text('  \n{"bit0":true,"bit1":false}'), { bit0: true, bit1: false }],
    ["bits missing from the JSON", Response.json({ last_update_time: "2026-10" }), { bit0: false, bit1: false }],
    ["non-boolean values", Response.json({ bit0: 1, bit1: "true" }), { bit0: false, bit1: false }],
    ["Bit State Not Found (never written)", text("Bit State Not Found"), { bit0: false, bit1: false }],
  ])("query with 200: %s", async (_name, response, expected) => {
    const { client } = fakeApple(() => response.clone());
    expect(await client.query("production", "tok")).toEqual(expected);
  });

  it.each([
    ["token rejected (400)", () => text("Missing or badly formatted authorization token", 400)],
    ["JWT rejected (401)", () => text("Unable to verify authorization token", 401)],
    ["Apple down (500)", () => text("", 500)],
    ["200 with broken JSON", () => text("{bit0:")],
    [
      "no response (timeout or network)",
      () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      },
    ],
  ])("query returns null: %s", async (_name, reply) => {
    const { client } = fakeApple(reply);
    expect(await client.query("production", "tok")).toBeNull();
  });

  it.each([true, false])("setBit0(%s): sends only bit0, leaving bit1 untouched", async (bit0) => {
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

  it("setBit0 with a 200 and no body: confirmed", async () => {
    const { client } = fakeApple(() => new Response(null, { status: 200 }));
    expect(await client.setBit0("production", "tok", true)).toBe(true);
  });

  it.each([
    ["400", () => text("Missing or incorrectly formatted device token payload", 400)],
    ["500", () => text("", 500)],
    [
      "no response",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("setBit0 not confirmed (%s): false", async (_name, reply) => {
    const { client } = fakeApple(reply);
    expect(await client.setBit0("production", "tok", true)).toBe(false);
  });
});
