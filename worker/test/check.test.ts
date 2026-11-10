import { describe, expect, it } from "vitest";
import { parseCheckRequest } from "../src/check";
import { refFromInstallHash } from "../src/hash";
import { FakeDeviceCheck, adminCall, check, guardEnv, logRows, randomHash, randomIds } from "./helpers";

const TOKEN = "dGVzdC10b2tlbi1xdWVyeQ==";
const TOKEN_UPDATE = "dGVzdC10b2tlbi11cGRhdGU=";

const ban = (app: string, kind: string, hash: string) =>
  adminCall("POST", "/v1/admin/ban", { app, kind, hash, note: "test" });

describe("POST /v1/device/check", () => {
  it("dispositivo limpio: ok, con el ref derivado del hash de install", async () => {
    const ids = randomIds();
    const dc = new FakeDeviceCheck();
    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(res).toEqual({ status: 200, body: { status: "ok", ref: refFromInstallHash(ids.install) } });
    expect(dc.writes()).toEqual([]);
  });

  it("ignora el ref que manda el cliente", async () => {
    const ids = randomIds();
    const res = await check({ ids, ref: "AAAAAAAA" } as never);
    expect(res.body.ref).toBe(refFromInstallHash(ids.install));
  });

  it("hash baneado con bit0 falso: escribe bit0 con el segundo token y bloquea", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck();

    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);

    expect(res.body.status).toBe("blocked");
    expect(dc.writes()).toEqual([{ op: "setBit0", env: "production", token: TOKEN_UPDATE, bit0: true }]);
    expect(dc.bits?.bit0).toBe(true);
  });

  // Apple pide no reutilizar un token: con uno solo se consulta, y bit0 se escribe en la siguiente
  // comprobación que traiga los dos.
  it("sin dc_token_update: bloquea por D1 pero no escribe bit0 hasta tener los dos tokens", async () => {
    const ids = randomIds();
    await ban("demo", "install", ids.install);
    const dc = new FakeDeviceCheck();

    expect((await check({ dc_token: TOKEN, ids, env: "development" }, dc)).body.status).toBe("blocked");
    expect(dc.calls).toEqual([{ op: "query", env: "development", token: TOKEN }]);

    await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids, env: "development" }, dc);
    expect(dc.writes()).toEqual([{ op: "setBit0", env: "development", token: TOKEN_UPDATE, bit0: true }]);
  });

  it("desbaneo sin dc_token_update: deja entrar sin escribir ni consumir el ref", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await ban("demo", "idfv", ids.idfv);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("ok");
    expect(dc.writes()).toEqual([]);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).toBeNull();
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "idfv", hash: ids.idfv });
    expect(row.body.banned).not.toBeNull();
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 1, bit0: 1, intent: "launch" }]);
  });

  it("bit0 ya activo: no reescribe", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck({ bit0: true });
    const res = await check({ dc_token: TOKEN, ids }, dc);
    expect(res.body.status).toBe("blocked");
    expect(dc.writes()).toEqual([]);
  });

  it("bit0 activo con identificadores nuevos: bloquea y los propaga a D1", async () => {
    const ids = randomIds(); // reinstalación tras borrar el iPhone, con otra cuenta de Apple
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("blocked");

    // Otro dispositivo con la misma cuenta de iCloud cae solo por D1.
    const other = { ...randomIds(), icloud: ids.icloud };
    expect((await check({ ids: other })).body.status).toBe("blocked");

    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toMatchObject({ reason: "propagated", kind: "icloud" });
  });

  it("bloqueo por un hash: propaga el resto y cae el otro iPhone con la misma cuenta de iCloud", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    expect((await check({ dc_token: TOKEN, ids }, new FakeDeviceCheck())).body.status).toBe("blocked");

    const otherPhone = { ...randomIds(), icloud: ids.icloud };
    expect((await check({ dc_token: TOKEN, ids: otherPhone }, new FakeDeviceCheck())).body.status).toBe("blocked");

    for (const kind of ["install", "icloud"] as const) {
      const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind, hash: ids[kind] });
      expect(row.body.banned).toMatchObject({ reason: "propagated" });
    }
  });

  it("dispositivo no bloqueado: no propaga nada", async () => {
    const ids = randomIds();
    await check({ dc_token: TOKEN, ids }, new FakeDeviceCheck());
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toBeNull();
  });

  it("la propagación no pisa una marca manual", async () => {
    const ids = randomIds();
    await ban("demo", "icloud", ids.icloud);
    // Bloqueado por el hash manual: la propagación inserta el resto sin tocar ese.
    await check({ dc_token: TOKEN, ids }, new FakeDeviceCheck({ bit0: true }));
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toMatchObject({ reason: "manual", note: "test" });
  });

  it("desbaneo por ref: limpia bit0, consume el ref y responde ok", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    const dc = new FakeDeviceCheck({ bit0: true });
    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("blocked");

    // Basta con el ref: el Worker borra los hashes que trae el propio dispositivo.
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });

    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(res.body.status).toBe("ok");
    expect(dc.bits?.bit0).toBe(false);
    expect(dc.writes().at(-1)).toMatchObject({ token: TOKEN_UPDATE, bit0: false });

    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).not.toBeNull();

    for (const [kind, hash] of Object.entries(ids)) {
      if (!hash) continue;
      const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind, hash });
      expect(row.body.banned).toBeNull();
    }

    // Siguiente comprobación: limpio de verdad.
    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("ok");
  });

  it("desbaneo con Apple caída: deja entrar pero no consume el ref", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });
    dc.failing = true;

    expect((await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc)).body.status).toBe("ok");
    expect(dc.writes()).toHaveLength(1);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).toBeNull();
  });

  it("Apple caída: decide solo con D1", async () => {
    const banned = randomIds();
    await ban("demo", "idfv", banned.idfv);
    const dc = new FakeDeviceCheck({ bit0: true });
    dc.failing = true;

    expect((await check({ dc_token: TOKEN, ids: banned }, dc)).body.status).toBe("blocked");
    expect((await check({ dc_token: TOKEN, ids: randomIds() }, dc)).body.status).toBe("ok");
  });

  it("sin dc_token (simulador): no llama a Apple", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck();
    expect((await check({ dc_token: null, ids }, dc)).body.status).toBe("blocked");
    expect(dc.calls).toEqual([]);
  });

  it("modo observación: responde ok pero registra blocked", async () => {
    const ids = randomIds();
    await ban("other", "idfv", ids.idfv);
    const res = await check({ app: "other", ids, intent: "login" });
    expect(res.body.status).toBe("ok");
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 1, matched: 1, bit0: null, intent: "login" },
    ]);
  });

  // Observación pura: mira D1 y Apple pero no cambia nada fuera de check_log. Al activar
  // ENFORCE, la primera comprobación de cada baneado escribe bit0 y propaga.
  it("modo observación con Apple: consulta bit0 pero no lo escribe ni propaga", async () => {
    const ids = randomIds();
    await ban("other", "idfv", ids.idfv);
    const dc = new FakeDeviceCheck();

    const res = await check({ app: "other", dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);

    expect(res.body.status).toBe("ok");
    expect(dc.calls).toEqual([{ op: "query", env: "production", token: TOKEN }]);
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "other", kind: "install", hash: ids.install });
    expect(row.body.banned).toBeNull();
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 1, matched: 1, bit0: 0, intent: "launch" },
    ]);
  });

  it("modo observación con bit0 activo: registra blocked sin propagar", async () => {
    const ids = randomIds();
    const dc = new FakeDeviceCheck({ bit0: true });

    expect((await check({ app: "other", dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc)).body.status).toBe("ok");

    const row = await adminCall("GET", "/v1/admin/lookup", { app: "other", kind: "icloud", hash: ids.icloud });
    expect(row.body.banned).toBeNull();
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 1, matched: 0, bit0: 1, intent: "launch" },
    ]);
  });

  it("aislamiento por app: un baneo en demo no afecta a other", async () => {
    const ids = randomIds();
    await ban("demo", "idfv", ids.idfv);
    await check({ app: "other", ids });
    expect(await logRows("other", refFromInstallHash(ids.install))).toEqual([
      { blocked: 0, matched: 0, bit0: null, intent: "launch" },
    ]);
  });

  it.each([
    ["sin install", { ids: { idfv: null, install: null } }, 400],
    ["hash con mayúsculas", { ids: { install: "A".repeat(64) } }, 400],
    ["intent desconocido", { ids: { install: "a".repeat(64) }, intent: "hack" }, 400],
    ["token con saltos de línea", { ids: { install: "a".repeat(64) }, dc_token: "abc\ndefghijklmnopqrs" }, 400],
    ["app sin configurar", { app: "nope", ids: { install: "a".repeat(64) } }, 404],
  ])("rechaza peticiones inválidas: %s", async (_name, body, status) => {
    expect((await check(body as never)).status).toBe(status);
  });

  it("no guarda identificadores en bruto ni IPs en check_log", async () => {
    const { results } = await guardEnv.DB.prepare("PRAGMA table_info(check_log)").all<{ name: string }>();
    expect(results.map((c) => c.name).sort()).toEqual(
      ["app", "bit0", "blocked", "created_at", "intent", "matched", "ref"].sort(),
    );
  });
});

describe("parseCheckRequest", () => {
  const install = "a".repeat(64);
  const valid = { app: "demo", ids: { install } };

  it("petición mínima: valores por defecto y ref derivado", () => {
    expect(parseCheckRequest(valid)).toEqual({
      app: "demo",
      env: "production",
      dcToken: null,
      dcTokenUpdate: null,
      ids: [{ kind: "install", hash: install }],
      ref: "AAAAAAAA",
      intent: "launch",
    });
  });

  it("lee los cuatro tipos de identificador de iOS", () => {
    const ids = { idfv: "1".repeat(64), install, icloud: "2".repeat(64), user: "3".repeat(64) };
    expect(parseCheckRequest({ ...valid, ids })?.ids.map((id) => id.kind)).toEqual(["idfv", "install", "icloud", "user"]);
  });

  it.each([
    ["cuerpo null", null],
    ["cuerpo string", "demo"],
    ["app inválida", { ...valid, app: "Demo!" }],
    ["env desconocido", { ...valid, env: "staging" }],
    ["ids null", { app: "demo", ids: null }],
    ["ids ausente", { app: "demo" }],
    ["dc_token numérico", { ...valid, dc_token: 1234567890123456 }],
    ["dc_token con basura al final", { ...valid, dc_token: "dGVzdC10b2tlbi1xdWVyeQ==!" }],
    ["dc_token demasiado largo", { ...valid, dc_token: "a".repeat(8193) }],
    ["dc_token demasiado corto", { ...valid, dc_token: "a".repeat(15) }],
    ["dc_token_update inválido", { ...valid, dc_token: TOKEN, dc_token_update: "corto" }],
    ["hash de idfv inválido", { app: "demo", ids: { install, idfv: "x" } }],
  ])("rechaza: %s", (_name, body) => {
    expect(parseCheckRequest(body)).toBeNull();
  });
});

describe("check: casos adicionales", () => {
  it("un baneo por user bloquea", async () => {
    const ids = { ...randomIds(), user: randomHash() };
    await ban("demo", "user", ids.user);
    expect((await check({ ids })).body.status).toBe("blocked");
  });

  it("app sin clave de Apple: el desbaneo por ref se consume solo con D1", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await ban("demo", "idfv", ids.idfv);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });

    expect((await check({ ids })).body.status).toBe("ok");
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).not.toBeNull();
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 1, bit0: null, intent: "launch" }]);
    expect((await check({ ids })).body.status).toBe("ok");
  });

  // Con clave de Apple, un desbaneo solo se consume cuando Apple confirma bit0 = false. Si la
  // comprobación llega sin dc_token (generateToken falló), deja entrar y espera a una con token;
  // si se consumiera, bit0 seguiría activo y el dispositivo volvería a quedar bloqueado.
  it("app con Apple y comprobación sin dc_token: deja entrar pero no consume ni borra hashes", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    const dc = new FakeDeviceCheck({ bit0: true });
    await ban("demo", "idfv", ids.idfv);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });

    expect((await check({ dc_token: null, ids }, dc)).body.status).toBe("ok");
    expect(dc.calls).toEqual([]);
    const lookup = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((lookup.body.unban as { consumed_at: number | null }).consumed_at).toBeNull();
    const row = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "idfv", hash: ids.idfv });
    expect(row.body.banned).not.toBeNull();
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 1, bit0: null, intent: "launch" }]);

    // La siguiente, con token: limpia bit0, borra los hashes y consume el desbaneo.
    const res = await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(res.body.status).toBe("ok");
    expect(dc.bits?.bit0).toBe(false);
    expect(dc.writes()).toEqual([{ op: "setBit0", env: "production", token: TOKEN_UPDATE, bit0: false }]);
    const after = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect((after.body.unban as { consumed_at: number | null }).consumed_at).not.toBeNull();
    const gone = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "idfv", hash: ids.idfv });
    expect(gone.body.banned).toBeNull();

    expect((await check({ dc_token: TOKEN, ids }, dc)).body.status).toBe("ok");
  });

  it("check_log del desbaneo: bit0 = 0 si Apple lo limpió", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, new FakeDeviceCheck({ bit0: true }));
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 0, bit0: 0, intent: "launch" }]);
  });

  it("check_log del desbaneo con Apple caída: bit0 desconocido", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await adminCall("POST", "/v1/admin/unban", { app: "demo", ref });
    const dc = new FakeDeviceCheck({ bit0: true });
    dc.failing = true;
    await check({ dc_token: TOKEN, dc_token_update: TOKEN_UPDATE, ids }, dc);
    expect(await logRows("demo", ref)).toEqual([{ blocked: 0, matched: 0, bit0: null, intent: "launch" }]);
  });

  it.each([
    [true, 1, "blocked"],
    [false, 0, "ok"],
  ] as const)("check_log registra el bit0 leído de Apple (%s)", async (bit0, logged, status) => {
    const ids = randomIds();
    const res = await check({ dc_token: TOKEN, ids, intent: "foreground" }, new FakeDeviceCheck({ bit0 }));
    expect(res.body.status).toBe(status);
    expect(await logRows("demo", refFromInstallHash(ids.install))).toEqual([
      { blocked: logged, matched: 0, bit0: logged, intent: "foreground" },
    ]);
  });

  it("lookup por ref devuelve las comprobaciones, la más reciente primero", async () => {
    const ids = randomIds();
    const ref = refFromInstallHash(ids.install);
    await check({ ids, intent: "launch" });
    await ban("demo", "idfv", ids.idfv);
    await check({ ids, intent: "login" });

    const { body } = await adminCall("GET", "/v1/admin/lookup", { app: "demo", ref });
    expect(body.unban).toBeNull();
    expect((body.checks as Record<string, unknown>[]).map(({ created_at: _, ...c }) => c)).toEqual([
      { blocked: 1, matched: 1, bit0: null, intent: "login" },
      { blocked: 0, matched: 0, bit0: null, intent: "launch" },
    ]);
  });
});
