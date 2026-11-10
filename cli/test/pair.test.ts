// `nongrata pair` and `nongrata devices` against a fake Worker: requests, polling, the y/N
// question and every way out. No network: fetch, stdin (ask) and sleep are injected.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_POLLS, parseArgs, POLL_MS, run, USAGE, type Io } from "../src/cli.ts";
import { encodeQr, renderHalfBlocks } from "../src/qr.ts";

const ENV = { NONGRATA_URL: "https://guard.example.com", NONGRATA_ADMIN_TOKEN: "tok" };
const ID = "q3VZbVqK0n8xJ3fR2sTgWw";
const DEVICE = "7sKpQ2mN4vX8yL1zR6tBcA";
const LINK = `nongrata://pair?v=1&url=https%3A%2F%2Fguard.example.com&id=${ID}&secret=${"S".repeat(43)}&role=admin&exp=1`;
const CLAIMED = {
  status: "claimed",
  role: "admin",
  label: null,
  expires_at: 1,
  device: { device_id: DEVICE, name: "iPhone 16 Pro", platform: "ios", verification_code: "012345" },
};

interface Script {
  /** What each GET of the pairing answers, in turn; the last one repeats. */
  polls?: unknown[];
  link?: string;
  fail?: { method: string; path: string; status: number };
}

/** A fake Worker for one pairing, plus everything the CLI printed, asked and slept. */
function harness(answer: string | null = "y", script: Script = {}, env: Io["env"] = ENV) {
  const requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const raw: { text: string; type: string | null }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const sleeps: number[] = [];
  const polls = [...(script.polls ?? [{ status: "pending" }, CLAIMED])];
  const io: Io = {
    env,
    fetch: async (input) => {
      const req = input as Request;
      const url = new URL(req.url);
      const text = await req.text();
      raw.push({ text, type: req.headers.get("content-type") });
      requests.push({
        method: req.method,
        path: `${url.host}${url.pathname}${url.search}`,
        auth: req.headers.get("authorization"),
        body: text === "" ? null : JSON.parse(text),
      });
      if (script.fail && script.fail.method === req.method && url.pathname === script.fail.path) {
        return Response.json({ error: "boom" }, { status: script.fail.status });
      }
      if (req.method === "POST" && url.pathname === "/v1/admin/pairings") {
        return Response.json({ id: ID, secret: "S".repeat(43), role: "admin", expires_at: 1, pair_url: script.link ?? LINK });
      }
      if (req.method === "GET") return Response.json(polls.length > 1 ? polls.shift() : polls[0]);
      if (req.method === "POST") return Response.json({ device_id: DEVICE, name: "iPhone 16 Pro", platform: "ios", role: "admin", status: "active" });
      return Response.json({ cancelled: true });
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ask: async (q) => {
      questions.push(q);
      return answer;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { io, requests, raw, out, err, questions, sleeps };
}

const QUESTION = "Verification code: 012 345. Does the device show the same code? [y/N] ";
const PAIRINGS = "guard.example.com/v1/admin/pairings";

describe("pair", () => {
  it("creates, shows the QR and the link, polls every 2 s, asks, approves", async () => {
    const h = harness("y");
    assert.equal(await run(["pair", "app=myapp", "role=admin", "label=Ana's iPhone"], h.io), 0);
    assert.deepEqual(h.requests, [
      { method: "POST", path: PAIRINGS, auth: "Bearer tok", body: { role: "admin", label: "Ana's iPhone" } },
      { method: "GET", path: `${PAIRINGS}/${ID}`, auth: "Bearer tok", body: null },
      { method: "GET", path: `${PAIRINGS}/${ID}`, auth: "Bearer tok", body: null },
      { method: "POST", path: `${PAIRINGS}/${ID}/approve`, auth: "Bearer tok", body: null },
    ]);
    assert.deepEqual(h.sleeps, [POLL_MS, POLL_MS]);
    assert.equal(POLL_MS, 2000);
    assert.deepEqual(h.out, [
      `Scan with NonGrata Dashboard (expires in 10 min):\n${renderHalfBlocks(encodeQr(LINK)!.modules)}`,
      `Or open: ${LINK}`,
      "Waiting for the device…",
      'Claimed by "iPhone 16 Pro" (ios).',
      `Paired: device ${DEVICE} with role admin.`,
    ]);
    assert.deepEqual(h.questions, [QUESTION]);
    assert.deepEqual(h.err, []);
  });

  it("without a label, or with an empty one, only the role is sent", async () => {
    for (const argv of [["pair", "app=myapp", "role=read"], ["pair", "app=myapp", "role=read", "label="]]) {
      const h = harness("y");
      assert.equal(await run(argv, h.io), 0);
      assert.deepEqual(h.requests[0]!.body, { role: "read" });
    }
  });

  for (const answer of ["y", "Y", "yes", "YES", " yes \n"]) {
    it(`answer ${JSON.stringify(answer)}: approved`, async () => {
      const h = harness(answer);
      assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 0);
      assert.equal(h.requests.at(-1)!.path, `${PAIRINGS}/${ID}/approve`);
    });
  }

  for (const answer of ["n", "", "no", "yess", "ye", "sure", "okay", "noyes", "yes?", null]) {
    it(`answer ${JSON.stringify(answer)}: cancelled, and exit code 1`, async () => {
      const h = harness(answer);
      assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 1);
      assert.deepEqual(h.requests.at(-1), { method: "DELETE", path: `${PAIRINGS}/${ID}`, auth: "Bearer tok", body: null });
      assert.ok(!h.requests.some((r) => r.path.endsWith("/approve")));
      assert.deepEqual(h.err, ["nongrata: not approved. The pairing was cancelled and that device removed."]);
      assert.equal(h.out.at(-1), 'Claimed by "iPhone 16 Pro" (ios).');
    });
  }

  for (const status of ["expired", "approved"]) {
    it(`the pairing turns ${status} while waiting: exit code 1, nothing asked`, async () => {
      const h = harness("y", { polls: [{ status: "pending" }, { status }] });
      assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 1);
      assert.deepEqual(h.err, [`nongrata: the pairing is ${status}. Run pair again.`]);
      assert.deepEqual(h.questions, []);
      assert.equal(h.requests.length, 3);
    });
  }

  it(`gives up after ${MAX_POLLS} polls of a pairing that stays pending`, async () => {
    const h = harness("y", { polls: [{ status: "pending" }] });
    assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 1);
    assert.equal(h.sleeps.length, MAX_POLLS);
    assert.equal(h.requests.filter((r) => r.method === "GET").length, MAX_POLLS);
    assert.ok(MAX_POLLS * POLL_MS > 10 * 60_000, "longer than the Worker's 10 minutes");
    assert.deepEqual(h.err, ["nongrata: no device claimed the pairing in time. Run pair again."]);
  });

  it("claimed on the first poll", async () => {
    const h = harness("y", { polls: [CLAIMED] });
    assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 0);
    assert.deepEqual(h.sleeps, [POLL_MS]);
  });

  for (const [method, path, after] of [
    ["POST", "/v1/admin/pairings", 1],
    ["GET", `/v1/admin/pairings/${ID}`, 2],
    ["POST", `/v1/admin/pairings/${ID}/approve`, 4],
  ] as const) {
    it(`HTTP error on ${method} ${path}: exit code 1 and the error`, async () => {
      const h = harness("y", { fail: { method, path, status: 403 } });
      assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 1);
      assert.equal(h.requests.length, after);
      assert.deepEqual(h.err, [`nongrata: HTTP 403\n${JSON.stringify({ error: "boom" }, null, 2)}`]);
    });
  }

  it("HTTP error on the cancel: exit code 1, only that error", async () => {
    const h = harness("n", { fail: { method: "DELETE", path: `/v1/admin/pairings/${ID}`, status: 500 } });
    assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 1);
    assert.equal(h.err.length, 1);
    assert.match(h.err[0]!, /^nongrata: HTTP 500/);
  });

  it("no response from the Worker: exit code 1", async () => {
    const h = harness();
    h.io.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 1);
    assert.deepEqual(h.err, ["nongrata: no response from https://guard.example.com: fetch failed"]);
  });

  it("an http link (wrangler dev): a warning on stderr, and it goes on", async () => {
    const link = "nongrata://pair?v=1&url=http%3A%2F%2Flocalhost%3A8787&id=x&secret=y&role=read&exp=1";
    const h = harness("y", { link }, { ...ENV, NONGRATA_URL: "http://localhost:8787" });
    assert.equal(await run(["pair", "app=myapp", "role=read"], h.io), 0);
    assert.deepEqual(h.err, ["nongrata: warning: this link uses plain http; it is only for wrangler dev on this machine."]);
  });

  it("an https link or one without url: no warning", async () => {
    for (const link of [LINK, "nongrata://pair?v=1&id=x", "nongrata://pair?v=1&url=xhttp%3A"]) {
      const h = harness("y", { link });
      assert.equal(await run(["pair", "app=myapp", "role=read"], h.io), 0);
      assert.deepEqual(h.err, [], link);
    }
  });

  it("a link too long for a QR code: only the link", async () => {
    const link = `nongrata://pair?v=1&url=${"x".repeat(300)}`;
    const h = harness("y", { link });
    assert.equal(await run(["pair", "app=myapp", "role=admin"], h.io), 0);
    assert.deepEqual(h.out.slice(0, 2), ["The link is too long for a QR code (expires in 10 min).", `Or open: ${link}`]);
  });

  it("app= picks the Worker: NONGRATA_URL_<APP> and NONGRATA_ADMIN_TOKEN_<APP>", async () => {
    const env = { ...ENV, NONGRATA_URL_MY_APP: "https://my-app.example.com", NONGRATA_ADMIN_TOKEN_MY_APP: "tok-2" };
    const h = harness("y", {}, env);
    assert.equal(await run(["pair", "app=my-app", "role=read"], h.io), 0);
    assert.ok(h.requests.every((r) => r.path.startsWith("my-app.example.com/") && r.auth === "Bearer tok-2"));
  });
});

describe("devices", () => {
  it("devices: GET /v1/admin/devices, without app in the query", async () => {
    const h = harness();
    assert.equal(await run(["devices", "app=myapp"], h.io), 0);
    assert.deepEqual(h.requests, [{ method: "GET", path: "guard.example.com/v1/admin/devices", auth: "Bearer tok", body: null }]);
  });

  it("devices revoke: POST to the device's revoke, with no body", async () => {
    const h = harness();
    assert.equal(await run(["devices", "revoke", "app=myapp", `id=${DEVICE}`], h.io), 0);
    assert.deepEqual(h.requests, [
      { method: "POST", path: `guard.example.com/v1/admin/devices/${DEVICE}/revoke`, auth: "Bearer tok", body: null },
    ]);
    assert.deepEqual(h.raw, [{ text: "", type: null }]);
    assert.deepEqual(h.out, [JSON.stringify({ device_id: DEVICE, name: "iPhone 16 Pro", platform: "ios", role: "admin", status: "active" }, null, 2)]);
  });

  it("parseArgs: devices revoke is one command; revoke is not a key=value", () => {
    assert.equal(parseArgs(["devices", "revoke", "app=a"]).command, "devices revoke");
    assert.deepEqual({ ...parseArgs(["devices", "revoke", "app=a"]).params }, { app: "a" });
    assert.equal(parseArgs(["devices", "app=a"]).command, "devices");
    assert.equal(parseArgs(["revoke", "app=a"]).command, "revoke");
    // Only after devices: anywhere else "revoke" is an argument without key=value.
    assert.throws(() => parseArgs(["ban", "revoke", "app=a"]), /argument not in key=value form: revoke/);
  });
});

describe("pair and devices: incorrect usage (exit code 2, nothing sent)", () => {
  const cases: [string, string[], string][] = [
    ["pair without role", ["pair", "app=myapp"], "missing role"],
    ["pair with another role", ["pair", "app=myapp", "role=root"], "invalid role: read or admin"],
    ["pair without app", ["pair", "role=admin"], "missing app"],
    ["pair with an unknown parameter", ["pair", "app=myapp", "role=admin", "name=x"], "unknown parameter: name"],
    ["devices with a filter", ["devices", "app=myapp", "role=admin"], "unknown parameter: role"],
    ["devices without app", ["devices"], "missing app"],
    ["devices list", ["devices", "list", "app=myapp"], "argument not in key=value form: list"],
    ["revoke without devices", ["revoke", "app=myapp", `id=${DEVICE}`], "unknown command: revoke"],
    ["devices revoke without id", ["devices", "revoke", "app=myapp"], "missing id"],
    ["devices revoke with a short id", ["devices", "revoke", "app=myapp", `id=${DEVICE.slice(1)}`], "invalid id: the device_id that devices lists"],
    ["devices revoke with a long id", ["devices", "revoke", "app=myapp", `id=${DEVICE}A`], "invalid id: the device_id that devices lists"],
    ["devices revoke with a slash", ["devices", "revoke", "app=myapp", `id=${DEVICE.slice(1)}/`], "invalid id: the device_id that devices lists"],
    ["devices revoke with an extra", ["devices", "revoke", "app=myapp", `id=${DEVICE}`, "x=1"], "unknown parameter: x"],
  ];
  for (const [name, argv, message] of cases) {
    it(name, async () => {
      const h = harness();
      assert.equal(await run(argv, h.io), 2);
      assert.equal(h.requests.length, 0);
      assert.deepEqual(h.err, [`nongrata: ${message}\n\n${USAGE}`]);
      assert.deepEqual(h.out, []);
    });
  }

  it("the help lists pair and devices", () => {
    assert.match(USAGE, /^  nongrata pair   app=<app> role=read\|admin \[label=<text>\]$/m);
    assert.match(USAGE, /^  nongrata devices revoke app=<app> id=<device id>$/m);
  });
});
