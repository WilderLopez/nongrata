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
  };
  return { io, requests, out, err };
}

describe("hash (sin red)", () => {
  for (const v of vectors.vectors) {
    it(`vector ${v.prefix} ${v.kind} ${v.value}`, async () => {
      const h = harness();
      const code = await run(["hash", `prefix=${v.prefix}`, `kind=${v.kind}`, `value=${v.value}`], h.io);
      assert.equal(code, 0);
      const result = JSON.parse(h.out[0]!);
      assert.equal(result.hash, v.hash);
      // El ref solo tiene sentido para el hash de install.
      assert.equal(result.ref, v.kind === "install" ? v.ref : undefined);
      assert.equal(h.requests.length, 0);
    });
  }
});

describe("ayuda", () => {
  for (const flag of ["help", "-h", "--help"]) {
    it(`${flag}: la ayuda por stdout y código 0`, async () => {
      const h = harness();
      assert.equal(await run([flag], h.io), 0);
      assert.deepEqual(h.out, [USAGE]);
      assert.deepEqual(h.err, []);
      assert.equal(h.requests.length, 0);
    });
  }

  it("sin argumentos: solo la ayuda, por stderr, y código 2", async () => {
    const h = harness();
    assert.equal(await run([], h.io), 2);
    assert.deepEqual(h.err, [USAGE]);
    assert.deepEqual(h.out, []);
  });

  it("lista los kind válidos", () => {
    assert.match(USAGE, /^kind: idfv, install, icloud, user, android_id$/m);
  });
});

describe("parseArgs", () => {
  it("parte por el primer '=': el valor puede contenerlo", () => {
    const { command, params } = parseArgs(["ban", "app=myapp", "note=a=b"]);
    assert.equal(command, "ban");
    // params no tiene prototipo (ver parseArgs): se compara su contenido.
    assert.deepEqual({ ...params }, { app: "myapp", note: "a=b" });
  });

  it("rechaza argumentos sin clave y claves repetidas", () => {
    assert.throws(() => parseArgs(["ban", "myapp"]), UsageError);
    assert.throws(() => parseArgs(["ban", "=x"]), UsageError);
    assert.throws(() => parseArgs(["ban", "app=a", "app=b"]), UsageError);
  });
});

describe("peticiones al Worker", () => {
  it("ban: POST con Bearer y el valor en bruto; el hash lo calcula el Worker", async () => {
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

  it("ban por hash", async () => {
    const h = harness();
    const hash = "b".repeat(64);
    assert.equal(await run(["ban", "app=myapp", "kind=icloud", `hash=${hash}`], h.io), 0);
    assert.deepEqual(await h.requests[0]!.json(), { app: "myapp", kind: "icloud", hash });
  });

  it("ban con note vacía: no manda note", async () => {
    const h = harness();
    assert.equal(await run(["ban", "app=myapp", "kind=idfv", "value=x", "note="], h.io), 0);
    assert.deepEqual(await h.requests[0]!.json(), { app: "myapp", kind: "idfv", value: "x" });
  });

  it("unban por ref: acepta minúsculas y manda mayúsculas", async () => {
    const h = harness();
    assert.equal(await run(["unban", "app=myapp", "ref=a1b2c3d4"], h.io), 0);
    assert.deepEqual(await h.requests[0]!.json(), { app: "myapp", ref: "A1B2C3D4" });
  });

  it("unban por identificador, con value o con hash", async () => {
    const byValue = harness();
    assert.equal(await run(["unban", "app=myapp", "kind=user", "value=u-1"], byValue.io), 0);
    assert.equal(byValue.requests[0]!.url, "https://guard.example.com/v1/admin/unban");
    assert.deepEqual(await byValue.requests[0]!.json(), { app: "myapp", kind: "user", value: "u-1" });

    const hash = "d".repeat(64);
    const byHash = harness();
    assert.equal(await run(["unban", "app=myapp", "kind=install", `hash=${hash}`], byHash.io), 0);
    assert.deepEqual(await byHash.requests[0]!.json(), { app: "myapp", kind: "install", hash });
  });

  it("lookup: GET con los parámetros en la query", async () => {
    const h = harness();
    const hash = "c".repeat(64);
    assert.equal(await run(["lookup", "app=myapp", "kind=user", `hash=${hash}`], h.io), 0);
    const url = new URL(h.requests[0]!.url);
    assert.equal(h.requests[0]!.method, "GET");
    assert.equal(h.requests[0]!.headers.get("authorization"), "Bearer tok");
    assert.equal(url.pathname, "/v1/admin/lookup");
    assert.deepEqual(Object.fromEntries(url.searchParams), { app: "myapp", kind: "user", hash });
  });

  it("lookup por ref y por value", async () => {
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

  it("las variables con sufijo de app tienen prioridad sobre las genéricas", async () => {
    const h = harness({
      ...ENV,
      NONGRATA_URL_MY_APP: "https://my-app.example.com",
      NONGRATA_ADMIN_TOKEN_MY_APP: "tok-my-app",
    });
    assert.equal(await run(["unban", "app=my-app", "ref=A1B2C3D4"], h.io), 0);
    assert.equal(new URL(h.requests[0]!.url).host, "my-app.example.com");
    assert.equal(h.requests[0]!.headers.get("authorization"), "Bearer tok-my-app");
  });

  it("http solo hacia localhost (wrangler dev)", async () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const local = harness({ ...ENV, NONGRATA_URL: url });
      assert.equal(await run(["unban", "app=demo", "ref=A1B2C3D4"], local.io), 0, url);
      assert.equal(local.requests[0]!.url, `${url}/v1/admin/unban`);
    }

    const remote = harness({ ...ENV, NONGRATA_URL: "http://guard.example.com" });
    assert.equal(await run(["unban", "app=demo", "ref=A1B2C3D4"], remote.io), 2);
    assert.equal(remote.requests.length, 0);
  });

  it("respuesta correcta: el JSON del Worker, indentado, por stdout", async () => {
    const h = harness(ENV, () => Response.json({ ok: true, hashes: 2 }));
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 0);
    assert.deepEqual(h.out, [JSON.stringify({ ok: true, hashes: 2 }, null, 2)]);
    assert.deepEqual(h.err, []);
  });

  it("respuesta que no es JSON: el texto tal cual", async () => {
    const h = harness(ENV, () => new Response("Internal Server Error", { status: 500 }));
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.deepEqual(h.err, ["nongrata: HTTP 500\nInternal Server Error"]);
    assert.deepEqual(h.out, []);
  });

  it("error del Worker: código 1 y el cuerpo por stderr", async () => {
    const h = harness(ENV, () => Response.json({ error: "unauthorized" }, { status: 401 }));
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.match(h.err[0]!, /HTTP 401/);
    assert.match(h.err[0]!, /unauthorized/);
  });

  it("sin respuesta: código 1", async () => {
    const h = harness();
    h.io.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.match(h.err[0]!, /sin respuesta de https:\/\/guard\.example\.com/);
  });

  it("corta la petición a los 15 s: código 1", async (t) => {
    const timeouts: number[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      timeouts.push(ms);
      return AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
    });
    const h = harness();
    // Como el fetch real: rechaza con el motivo de la señal si ya está abortada.
    h.io.fetch = async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return Response.json({ ok: true });
    };
    assert.equal(await run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), 1);
    assert.deepEqual(timeouts, [15_000]);
    assert.deepEqual(h.err, ["nongrata: sin respuesta de https://guard.example.com: timeout"]);
  });

  it("un error que no es de uso no se disfraza de uso incorrecto", async () => {
    // Un token con salto de línea no es una cabecera válida: Request lanza TypeError.
    const h = harness({ ...ENV, NONGRATA_ADMIN_TOKEN: "to\nk" });
    await assert.rejects(run(["unban", "app=myapp", "ref=A1B2C3D4"], h.io), TypeError);
    assert.deepEqual(h.err, []);
    assert.equal(h.requests.length, 0);
  });
});

describe("uso incorrecto: código 2, el motivo y la ayuda por stderr, y nada sale por la red", () => {
  const hashA = "a".repeat(64);
  const badKind = "kind inválido: ip (idfv, install, icloud, user, android_id)";
  const https = "la URL debe ser https (http solo para localhost)";
  const cases: [string, string[], string, Io["env"]?][] = [
    ["argumento sin clave=valor", ["ban", "myapp"], "argumento sin formato clave=valor: myapp"],
    ["clave repetida", ["ban", "app=a", "app=b"], "app repetido"],
    ["comando desconocido", ["purge", "app=myapp"], "comando desconocido: purge"],
    ["sin app", ["ban", "kind=idfv", "value=x"], "falta app"],
    ["sin kind", ["ban", "app=myapp", "value=x"], "falta kind"],
    ["kind inválido", ["ban", "app=myapp", "kind=ip", "value=1.2.3.4"], badKind],
    ["value y hash a la vez", ["ban", "app=myapp", "kind=idfv", "value=x", `hash=${hashA}`], "indica value o hash, no ambos"],
    ["ni value ni hash", ["ban", "app=myapp", "kind=idfv"], "indica value o hash, no ambos"],
    ["value vacío", ["ban", "app=myapp", "kind=idfv", "value="], "value vacío"],
    [
      "hash mal formado",
      ["ban", "app=myapp", "kind=idfv", `hash=${"A".repeat(64)}`],
      "hash inválido: 64 caracteres hex en minúsculas",
    ],
    ["parámetro con errata", ["ban", "app=myapp", "kind=idfv", "value=x", "nota=spam"], "parámetro desconocido: nota"],
    // Nombres que existen en Object.prototype: siguen siendo parámetros desconocidos, no repetidos.
    ["parámetro constructor", ["ban", "app=myapp", "kind=idfv", "value=x", "constructor=x"], "parámetro desconocido: constructor"],
    ["parámetro toString", ["ban", "app=myapp", "kind=idfv", "value=x", "toString=x"], "parámetro desconocido: toString"],
    ["parámetro __proto__", ["ban", "app=myapp", "kind=idfv", "value=x", "__proto__=x"], "parámetro desconocido: __proto__"],
    [
      "varios parámetros desconocidos",
      ["ban", "app=myapp", "kind=idfv", "value=x", "nota=spam", "motivo=x"],
      "parámetro desconocido: nota, motivo",
    ],
    ["ref inválido", ["unban", "app=myapp", "ref=XYZ"], "ref inválido: 8 caracteres hex"],
    [
      "ref e identificador a la vez",
      ["unban", "app=myapp", "ref=A1B2C3D4", "kind=idfv", "value=x"],
      "parámetro desconocido: kind, value",
    ],
    ["ban por ref", ["ban", "app=myapp", "ref=A1B2C3D4"], "parámetro desconocido: ref"],
    [
      "sin token",
      ["unban", "app=my-app", "ref=A1B2C3D4"],
      "falta NONGRATA_ADMIN_TOKEN_MY_APP o NONGRATA_ADMIN_TOKEN",
      { NONGRATA_URL: ENV.NONGRATA_URL },
    ],
    [
      "sin URL",
      ["unban", "app=my-app", "ref=A1B2C3D4"],
      "falta NONGRATA_URL_MY_APP o NONGRATA_URL",
      { NONGRATA_ADMIN_TOKEN: "tok" },
    ],
    ["URL inválida", ["unban", "app=myapp", "ref=A1B2C3D4"], "URL inválida: guard", { ...ENV, NONGRATA_URL: "guard" }],
    ["http fuera de localhost", ["unban", "app=myapp", "ref=A1B2C3D4"], https, { ...ENV, NONGRATA_URL: "http://guard.example.com" }],
    ["otro esquema hacia localhost", ["unban", "app=myapp", "ref=A1B2C3D4"], https, { ...ENV, NONGRATA_URL: "ftp://localhost:8787" }],
    ["hash sin prefix", ["hash", "kind=idfv", "value=x"], "falta prefix"],
    ["hash con kind inválido", ["hash", "prefix=p", "kind=ip", "value=1.2.3.4"], badKind],
    ["hash con parámetro desconocido", ["hash", "prefix=p", "kind=idfv", "value=x", "app=myapp"], "parámetro desconocido: app"],
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
