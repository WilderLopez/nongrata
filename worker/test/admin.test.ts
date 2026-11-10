import { describe, expect, it } from "vitest";
import vectors from "../../spec/hash-vectors.json";
import type { GuardEnv } from "../src/env";
import { handle } from "../src/index";
import { adminCall, check, guardEnv, randomHash } from "./helpers";

describe("admin", () => {
  it.each([
    ["sin token", null],
    ["token incorrecto", "nope"],
  ])("401 %s", async (_name, token) => {
    const res = await adminCall("POST", "/v1/admin/ban", { app: "demo", kind: "idfv", value: "x" }, token);
    expect(res.status).toBe(401);
  });

  it("ban con value: el Worker calcula el hash con el prefijo de la app", async () => {
    const res = await adminCall("POST", "/v1/admin/ban", {
      app: "demo",
      kind: "idfv",
      value: "E621E1F8-C36C-495A-93FC-0C247A3E6E5F",
    });
    expect(res.status).toBe(200);
    // Mismo valor que el vector de myapp pero con otro prefijo: el hash debe ser distinto.
    const myapp = vectors.vectors.find((v) => v.prefix === "myapp-ban-v1" && v.kind === "idfv")!;
    expect(res.body.hash).not.toBe(myapp.hash);
    expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);

    const blocked = await check({ ids: { idfv: res.body.hash as string, install: "b".repeat(64) } });
    expect(blocked.body.status).toBe("blocked");
  });

  it("unban por hash lo borra; lookup lo confirma", async () => {
    const hash = "c".repeat(64);
    await adminCall("POST", "/v1/admin/ban", { app: "demo", kind: "user", hash });
    expect((await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "user", hash })).body.banned).not.toBeNull();

    const res = await adminCall("POST", "/v1/admin/unban", { app: "demo", kind: "user", hash });
    expect(res.body).toMatchObject({ removed: true });
    expect((await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "user", hash })).body.banned).toBeNull();
  });

  it.each([
    ["kind inválido", { app: "demo", kind: "ip", value: "1.2.3.4" }],
    ["ref inválido", { app: "demo", ref: "abc" }],
    ["sin nada que desbanear", { app: "demo" }],
  ])("400 en unban: %s", async (_name, payload) => {
    expect((await adminCall("POST", "/v1/admin/unban", payload)).status).toBe(400);
  });

  it("ruta desconocida: 404", async () => {
    expect((await adminCall("GET", "/v1/admin/nope")).status).toBe(404);
  });
});

const TOKEN = "test-admin-token";

/** Petición de admin con cuerpo y cabeceras a mano (JSON roto, otros esquemas de autorización). */
async function rawAdmin(path: string, init: RequestInit, env: GuardEnv = guardEnv) {
  const res = await handle(new Request(`https://guard.test${path}`, init), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("admin: autorización", () => {
  it("Worker sin ADMIN_TOKEN: rechaza incluso un Bearer vacío", async () => {
    const env = { ...guardEnv, ADMIN_TOKEN: undefined } as GuardEnv;
    const res = await rawAdmin("/v1/admin/lookup?app=demo&ref=AAAAAAAA", { headers: { authorization: "Bearer " } }, env);
    expect(res).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("el token con otro esquema que no sea Bearer: 401", async () => {
    const res = await rawAdmin("/v1/admin/lookup?app=demo&ref=AAAAAAAA", {
      headers: { authorization: `Basic: ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("el token correcto con Bearer: autorizado", async () => {
    const res = await rawAdmin("/v1/admin/lookup?app=demo&ref=AAAAAAAA", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("admin: validaciones (400 con el motivo)", () => {
  const post = (path: string, body: string) =>
    rawAdmin(path, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });

  it.each(["/v1/admin/ban", "/v1/admin/unban"])("%s con JSON roto: app inválida", async (path) => {
    expect(await post(path, "{")).toEqual({ status: 400, body: { error: "app inválida" } });
  });

  it.each([
    ["ban", { app: "Demo!", kind: "idfv", value: "x" }, "app inválida"],
    ["ban", { app: "demo", kind: "idfv" }, "falta value o hash"],
    ["ban", { app: "demo", kind: "ip", value: "1.2.3.4" }, "kind inválido"],
    ["ban", { app: "demo", kind: "idfv", hash: "ABC" }, "hash inválido"],
    ["ban", { app: "demo", kind: "idfv", value: "" }, "value inválido"],
    ["ban", { app: "demo", kind: "idfv", value: 123 }, "value inválido"],
    ["ban", { app: "nope", kind: "idfv", value: "x" }, "app sin configurar"],
    ["unban", { app: "Demo!", ref: "A1B2C3D4" }, "app inválida"],
    ["unban", { app: "demo", ref: "a1b2c3d4" }, "ref inválido"],
    ["unban", { app: "demo" }, "falta value, hash o ref"],
    ["unban", { app: "demo", kind: "ip", value: "x" }, "kind inválido"],
  ])("%s %j: %s", async (op, payload, error) => {
    expect(await adminCall("POST", `/v1/admin/${op}`, payload)).toEqual({ status: 400, body: { error } });
  });

  it.each([
    [{ app: "Demo!", ref: "A1B2C3D4" }, "app inválida"],
    [{ app: "demo", ref: "a1b2c3d4" }, "ref inválido"],
    [{ app: "demo" }, "falta ref, value o hash"],
    [{ app: "demo", kind: "ip", value: "x" }, "kind inválido"],
  ])("lookup %j: %s", async (payload, error) => {
    expect(await adminCall("GET", "/v1/admin/lookup", payload)).toEqual({ status: 400, body: { error } });
  });
});

describe("admin: respuestas", () => {
  it("ban guarda la nota recortada a 500 caracteres", async () => {
    const hash = randomHash();
    await adminCall("POST", "/v1/admin/ban", { app: "demo", kind: "user", hash, note: "n".repeat(600) });
    const res = await adminCall("GET", "/v1/admin/lookup", { app: "demo", kind: "user", hash });
    expect((res.body.banned as { note: string }).note).toBe("n".repeat(500));
  });

  it("unban por ref: confirma app, ref y que quedó programado", async () => {
    const res = await adminCall("POST", "/v1/admin/unban", { app: "demo", ref: "B1B2C3D4" });
    expect(res).toEqual({ status: 200, body: { app: "demo", ref: "B1B2C3D4", unban_scheduled: true } });
  });

  it("unban de un hash que no estaba: removed false", async () => {
    const hash = randomHash();
    const res = await adminCall("POST", "/v1/admin/unban", { app: "demo", kind: "idfv", hash });
    expect(res.body).toEqual({ app: "demo", hash, removed: false });
  });
});

// Una errata en `app` no puede dar un 200 que no hace nada: el Worker de cada despliegue solo
// conoce sus apps configuradas (HASH_PREFIX_<APP>), también cuando llega `hash` o `ref`.
describe("admin: app sin configurar (errata en app)", () => {
  const rows = async (table: "banned_ids" | "unban_refs", app: string) =>
    (await guardEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app = ?`).bind(app).first<{ n: number }>())!.n;

  it.each([
    ["POST", "ban", { kind: "idfv", hash: "d".repeat(64) }],
    ["POST", "unban", { ref: "A1B2C3D4" }],
    ["POST", "unban", { kind: "idfv", hash: "d".repeat(64) }],
    ["GET", "lookup", { ref: "A1B2C3D4" }],
    ["GET", "lookup", { kind: "idfv", hash: "d".repeat(64) }],
  ] as const)("%s %s %j: 400 y nada en D1", async (method, op, payload) => {
    const res = await adminCall(method, `/v1/admin/${op}`, { app: "kits", ...payload });
    expect(res).toEqual({ status: 400, body: { error: "app sin configurar" } });
    expect(await rows("banned_ids", "kits")).toBe(0);
    expect(await rows("unban_refs", "kits")).toBe(0);
  });

  it("app mal formada sigue siendo 'app inválida', antes que 'sin configurar'", async () => {
    const res = await adminCall("POST", "/v1/admin/unban", { app: "Kits!", ref: "A1B2C3D4" });
    expect(res).toEqual({ status: 400, body: { error: "app inválida" } });
  });

  it("una app configurada en modo observación sí admite hash y ref", async () => {
    const hash = randomHash();
    expect((await adminCall("POST", "/v1/admin/ban", { app: "other", kind: "idfv", hash })).status).toBe(200);
    expect((await adminCall("POST", "/v1/admin/unban", { app: "other", ref: "C1B2C3D4" })).status).toBe(200);
  });
});
