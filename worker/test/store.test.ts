import { describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { guardEnv } from "./helpers";

describe("Store", () => {
  it("anyBanned sin hashes: nunca hay baneo", async () => {
    expect(await new Store(guardEnv.DB).anyBanned("demo", [])).toBe(false);
  });

  // D1 rechaza un batch vacío ("No SQL statements detected"): la guarda es necesaria.
  it("insertPropagated sin identificadores no llama a D1", async () => {
    await expect(new Store(guardEnv.DB).insertPropagated("demo", [], Date.now())).resolves.toBeUndefined();
  });
});
