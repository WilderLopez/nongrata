import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vectors from "../../spec/hash-vectors.json" with { type: "json" };
import { parseArgs, run, USAGE, UsageError, type Io } from "../src/cli.ts";

const ENV = { NONGRATA_URL: "https://guard.example.com", NONGRATA_ADMIN_TOKEN: "tok" };

function harness(env: Io["env"] = ENV, reply = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env,
    fetch: async (input) => {
      requests.push(input as Request);
      return reply();
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ask: async () => {
      throw new Error("no command but pair asks");
    },
    sleep: async () => {},
  };
  return { io, requests, out, err };
}

describe("hash (offline)", () => {
  for (const v of vectors.vectors) {
    it(`vector ${v.prefix} ${v.kind} ${v.value}`, async () => {
      const h = harness();
      const code = await run(["hash", `prefix=${v.prefix}`, `kind=${v.kind}`, `value=${v.value}`], h.io);
      assert.equal(code, 0);
      const result = JSON.parse(h.out[0]!);
      assert.equal(result.hash, v.hash);
      // A ref only makes sense for the install hash.
      assert.equal(result.ref, v.kind === "install" ? v.ref : undefined);
      assert.equal(h.requests.length, 0);
    });
  }
});

describe("help", () => {
  for (const flag of ["help", "-h", "--help"]) {
    it(`${flag}: help on stdout and exit code 0`, async () => {
      const h = harness();
      assert.equal(await run([flag], h.io), 0);
      assert.deepEqual(h.out, [USAGE]);
      assert.deepEqual(h.err, []);
      assert.equal(h.requests.length, 0);
    });
  }

  it("no arguments: only the help, on stderr, and exit code 2", async () => {
    const h = harness();
    assert.equal(await run([], h.io), 2);
    assert.deepEqual(h.err, [USAGE]);
    assert.deepEqual(h.out, []);
  });

  it("lists the valid kinds", () => {
    assert.match(USAGE, /^kind: idfv, install, icloud, user, android_id$/m);
  });
});

describe("parseArgs", () => {
  it("splits on the first '=': the value may contain one", () => {
    const { command, params } = parseArgs(["ban", "app=myapp", "note=a=b"]);
    assert.equal(command, "ban");
    // params has no prototype (see parseArgs): compare its contents.
    assert.deepEqual({ ...params }, { app: "myapp", note: "a=b" });
  });

  it("rejects arguments without a key and duplicate keys", () => {
    assert.throws(() => parseArgs(["ban", "myapp"]), UsageError);
    assert.throws(() => parseArgs(["ban", "=x"]), UsageError);
    assert.throws(() => parseArgs(["ban", "app=a", "app=b"]), UsageError);
  });
});

describe("requests to the Worker", () => {
  it("ban: POST with Bearer and the raw value; the Worker computes the hash", async () => {
    const h = harness();
    const code = await run(["ban", "app=myapp", "kind=idfv", "value=E621E1F8", "note=spam"], h.io);
    assert.equal(code, 0);
    const [req] = h.requests;
    assert.equal(req!.method, "POST");
    assert.equal(req!.url, "https://guard.example.com/v1/admin/ban");
    assert.equal(req!.headers.get("authorization"), "Bearer tok");
    assert.equal(req!.headers.get("content-type"), "application/json");
    assert.deepEqual(await req!.json(), { app: "myapp", kind: "idfv", value: "E621E1F8", note: "spam" });
  });

  it("ban by hash", async () => {
    const h = harness();
    const hash = "b".repeat(64);
    assert.equal(await run(["ban", "app=myapp", "kind=icloud", `hash=${hash}`], h.io), 0);
    assert.deepEqual(await h.requests[0]!.json(), { app: "myapp", kind: "icloud", hash });
  });

  it("ban with an empty note: note is not sent", async () => {
    const h = harness();
    assert.equal(await run(["ban", "app=myapp", "kind=idfv", "value=x", "note="], h.io), 0);
    assert.deepEqual(await h.requests[0]!.json(), { app: "myapp", kind: "idfv", value: "x" });
  });

  it("unban by ref: accepts lowercase and sends uppercase", async () => {
    const h = harness();
    assert.equal(await run(["unban", "app=myapp", "ref=a1b2c3d4"], h.io), 0);
    assert.deepEqual(await h.requests[0]!.json(), { app: "myapp", ref: "A1B2C3D4" });
  });

  it("unban by identifier, with value or with hash", async () => {
    const byValue = harness();
    assert.equal(await run(["unban", "app=myapp", "kind=user", "value=u-1"], byValue.io), 0);
    assert.equal(byValue.requests[0]!.url, "https://guard.example.com/v1/admin/unban");
    assert.deepEqual(await byValue.requests[0]!.json(), { app: "myapp", kind: "user", value: "u-1" });

    const hash = "d".repeat(64);
    const byHash = harness();
    assert.equal(await run(["unban", "app=myapp", "kind=install", `hash=${hash}`], byHash.io), 0);
    assert.deepEqual(await byHash.requests[0]!.json(), { app: "myapp", kind: "install", hash });
  });

  it("lookup: GET with the parameters in the query string", async () => {
    const h = harness();
    const hash = "c".repeat(64);
    assert.equal(await run(["lookup", "app=myapp", "kind=user", `hash=${hash}`], h.io), 0);
    const url = new URL(h.requests[0]!.url);
    assert.equal(h.requests[0]!.method, "GET");
    assert.equal(h.requests[0]!.headers.get("authorization"), "Bearer tok");
    assert.equal(url.pathname, "/v1/admin/lookup");
    assert.deepEqual(Object.fromEntries(url.searchParams), { app: "myapp", kind: "user", hash });
  });

  it("lookup by ref and by value", async () => {
    const byRef = harness();
    assert.equal(await run(["lookup", "app=myapp", "ref=a1b2c3d4"], byRef.io), 0);
    assert.deepEqual(Object.fromEntries(new URL(byRef.requests[0]!.url).searchParams), {
      app: "myapp",
      ref: "A1B2C3D4",
    });

    const byValue = harness();
    assert.equal(await run(["lookup", "app=myapp", "kind=idfv", "value=E621E1F8"], byValue.io), 0);
    assert.deepEqual(Object.fromEntries(new URL(byValue.requests[0]!.url).searchParams), {
      app: "myapp",
      kind: "idfv",
      value: "E621E1F8",
    });
  });

  const listingQuery = async (argv: string[]) => {
    const h = harness();
    assert.equal(await run(argv, h.io), 0);
    const req = h.requests[0]!;
    assert.equal(req.method, "GET");
    assert.equal(req.headers.get("authorization"), "Bearer tok");
    const url = new URL(req.url);
    return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
  };

  it("bans: GET with the filters and the page in the query string", async () => {
    assert.deepEqual(await listingQuery(["bans", "app=myapp"]), { path: "/v1/admin/bans", query: { app: "myapp" } });
    assert.deepEqual(
      await listingQuery(["bans", "app=myapp", "kind=icloud", "reason=propagated", "limit=10", "cursor=MTAuZmY"]),
      {
        path: "/v1/admin/bans",
        query: { app: "myapp", kind: "icloud", reason: "propagated", limit: "10", cursor: "MTAuZmY" },
      },
    );
  });

  it("checks: the ref in uppercase; the other filters as given (the Worker checks them)", async () => {
    assert.deepEqual(await listingQuery(["checks", "app=myapp"]), { path: "/v1/admin/checks", query: { app: "myapp" } });
    assert.deepEqual(
      await listingQuery(["checks", "app=myapp", "ref=a1b2c3d4", "blocked=1", "since=1700000000000", "limit=5", "cursor=c"]),
      {
        path: "/v1/admin/checks",
        query: { app: "myapp", ref: "A1B2C3D4", blocked: "1", since: "1700000000000", limit: "5", cursor: "c" },
      },
    );
  });

  it("log: GET with the page in the query string", async () => {
    assert.deepEqual(await listingQuery(["log", "app=myapp"]), { path: "/v1/admin/log", query: { app: "myapp" } });
    assert.deepEqual(await listingQuery(["log", "app=myapp", "limit=100", "cursor=c"]), {
      path: "/v1/admin/log",
      query: { app: "myapp", limit: "100", cursor: "c" },
    });
  });

  it("app-suffixed variables take precedence over the generic ones", async () => {
    const h = harness({
      ...ENV,
      NONGRATA_URL_MY_APP: "https://my-app.example.com",
      NONGRATA_ADMIN_TOKEN_MY_APP: "tok-my-app",
    });
    assert.equal(await run(["unban", "app=my-app", "ref=A1B2C3D4"], h.io), 0);
    assert.equal(new URL(h.requests[0]!.url).host, "my-app.example.com");
    assert.equal(h.requests[0]!.headers.get("authorization"), "Bearer tok-my-app");
  });

  it("http only towards localhost (wrangler dev)", async () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const local = harness({ ...ENV, NONGRATA_URL: url });
      assert.equal(await run(["unban", "app=demo", "ref=A1B2C3D4"], local.io), 0, url);
      assert.equal(local.requests[0]!.url, `${url}/v1/admin/unban`);
    }

    const remote = harness({ ...ENV, NONGRATA_URL: "http://guard.example.com" });
    assert.equal(await run(["unban", "app=demo", "ref=A1B2C3D4"], remote.io), 2);
    assert.equal(remote.requests.length, 0);
  });

  it("successful response: the Worker's JSON, indented, on stdout", async () => {
    const h = harness(ENV, () => Response.json({ ok: true, hashes: 2 }));
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 0);
    assert.deepEqual(h.out, [JSON.stringify({ ok: true, hashes: 2 }, null, 2)]);
    assert.deepEqual(h.err, []);
  });

  it("non-JSON response: the text as is", async () => {
    const h = harness(ENV, () => new Response("Internal Server Error", { status: 500 }));
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.deepEqual(h.err, ["nongrata: HTTP 500\nInternal Server Error"]);
    assert.deepEqual(h.out, []);
  });

  it("Worker error: exit code 1 and the body on stderr", async () => {
    const h = harness(ENV, () => Response.json({ error: "unauthorized" }, { status: 401 }));
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.match(h.err[0]!, /HTTP 401/);
    assert.match(h.err[0]!, /unauthorized/);
  });

  it("no response: exit code 1", async () => {
    const h = harness();
    h.io.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.match(h.err[0]!, /no response from https:\/\/guard\.example\.com/);
  });

  it("aborts the request after 15 s: exit code 1", async (t) => {
    const timeouts: number[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      timeouts.push(ms);
      return AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
    });
    const h = harness();
    // Like the real fetch: rejects with the signal's reason if it is already aborted.
    h.io.fetch = async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return Response.json({ ok: true });
    };
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.deepEqual(timeouts, [15_000]);
    assert.deepEqual(h.err, ["nongrata: no response from https://guard.example.com: timeout"]);
  });

  it("an error that is not a usage error is not disguised as one", async () => {
    // A token with a newline is not a valid header value: Request throws TypeError.
    const h = harness({ ...ENV, NONGRATA_ADMIN_TOKEN: "to\nk" });
    await assert.rejects(run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), TypeError);
    assert.deepEqual(h.err, []);
    assert.equal(h.requests.length, 0);
  });
});

describe("incorrect usage: exit code 2, the reason and the help on stderr, and nothing goes out on the network", () => {
  const hashA = "a".repeat(64);
  const badKind = "invalid kind: ip (idfv, install, icloud, user, android_id)";
  const https = "the URL must be https (http only for localhost)";
  const cases: [string, string[], string, Io["env"]?][] = [
    ["argument without key=value", ["ban", "myapp"], "argument not in key=value form: myapp"],
    ["duplicate key", ["ban", "app=a", "app=b"], "duplicate parameter: app"],
    ["unknown command", ["purge", "app=myapp"], "unknown command: purge"],
    ["no app", ["ban", "kind=idfv", "value=x"], "missing app"],
    ["no kind", ["ban", "app=myapp", "value=x"], "missing kind"],
    ["invalid kind", ["ban", "app=myapp", "kind=ip", "value=1.2.3.4"], badKind],
    ["value and hash at once", ["ban", "app=myapp", "kind=idfv", "value=x", `hash=${hashA}`], "give value or hash, not both"],
    ["neither value nor hash", ["ban", "app=myapp", "kind=idfv"], "give value or hash, not both"],
    ["empty value", ["ban", "app=myapp", "kind=idfv", "value="], "empty value"],
    [
      "malformed hash",
      ["ban", "app=myapp", "kind=idfv", `hash=${"A".repeat(64)}`],
      "invalid hash: 64 lowercase hex characters",
    ],
    ["misspelled parameter", ["ban", "app=myapp", "kind=idfv", "value=x", "nota=spam"], "unknown parameter: nota"],
    // Names that exist on Object.prototype: still unknown parameters, not duplicates.
    ["constructor parameter", ["ban", "app=myapp", "kind=idfv", "value=x", "constructor=x"], "unknown parameter: constructor"],
    ["toString parameter", ["ban", "app=myapp", "kind=idfv", "value=x", "toString=x"], "unknown parameter: toString"],
    ["__proto__ parameter", ["ban", "app=myapp", "kind=idfv", "value=x", "__proto__=x"], "unknown parameter: __proto__"],
    [
      "several unknown parameters",
      ["ban", "app=myapp", "kind=idfv", "value=x", "nota=spam", "motivo=x"],
      "unknown parameter: nota, motivo",
    ],
    ["invalid ref", ["unban", "app=myapp", "ref=XYZ"], "invalid ref: 8 hex characters"],
    [
      "ref and identifier at once",
      ["unban", "app=myapp", "ref=A1B2C3D4", "kind=idfv", "value=x"],
      "unknown parameter: kind, value",
    ],
    ["ban by ref", ["ban", "app=myapp", "ref=A1B2C3D4"], "unknown parameter: ref"],
    ["bans without app", ["bans", "kind=idfv"], "missing app"],
    ["bans with an invalid kind", ["bans", "app=myapp", "kind=ip"], badKind],
    ["bans with an empty kind", ["bans", "app=myapp", "kind="], "invalid kind:  (idfv, install, icloud, user, android_id)"],
    ["bans by ref", ["bans", "app=myapp", "ref=A1B2C3D4"], "unknown parameter: ref"],
    ["checks with an invalid ref", ["checks", "app=myapp", "ref=XYZ"], "invalid ref: 8 hex characters"],
    ["checks by kind", ["checks", "app=myapp", "kind=idfv"], "unknown parameter: kind"],
    ["log with a filter", ["log", "app=myapp", "reason=manual"], "unknown parameter: reason"],
    ["log without app", ["log", "limit=5"], "missing app"],
    [
      "no token",
      ["unban", "app=my-app", "ref=A1B2C3D4"],
      "missing NONGRATA_ADMIN_TOKEN_MY_APP or NONGRATA_ADMIN_TOKEN",
      { NONGRATA_URL: ENV.NONGRATA_URL },
    ],
    [
      "no URL",
      ["unban", "app=my-app", "ref=A1B2C3D4"],
      "missing NONGRATA_URL_MY_APP or NONGRATA_URL",
      { NONGRATA_ADMIN_TOKEN: "tok" },
    ],
    ["invalid URL", ["unban", "app=myapp", "ref=A1B2C3D4"], "invalid URL: guard", { ...ENV, NONGRATA_URL: "guard" }],
    ["http outside localhost", ["unban", "app=myapp", "ref=A1B2C3D4"], https, { ...ENV, NONGRATA_URL: "http://guard.example.com" }],
    ["another scheme towards localhost", ["unban", "app=myapp", "ref=A1B2C3D4"], https, { ...ENV, NONGRATA_URL: "ftp://localhost:8787" }],
    ["hash without prefix", ["hash", "kind=idfv", "value=x"], "missing prefix"],
    ["hash with an invalid kind", ["hash", "prefix=p", "kind=ip", "value=1.2.3.4"], badKind],
    ["hash with an unknown parameter", ["hash", "prefix=p", "kind=idfv", "value=x", "app=myapp"], "unknown parameter: app"],
  ];
  for (const [name, argv, message, env] of cases) {
    it(name, async () => {
      const h = harness(env);
      assert.equal(await run(argv, h.io), 2);
      assert.equal(h.requests.length, 0);
      assert.deepEqual(h.err, [`nongrata: ${message}\n\n${USAGE}`]);
      assert.deepEqual(h.out, []);
    });
  }
});
