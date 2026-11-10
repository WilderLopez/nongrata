import { describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { guardEnv, randomHash } from "./helpers";

describe("Store", () => {
  it("anyBanned with no hashes: never banned", async () => {
    expect(await new Store(guardEnv.DB).anyBanned("demo", [])).toBe(false);
  });

  // D1 rejects an empty batch ("No SQL statements detected"): the guard is required.
  it("insertPropagated with no identifiers does not call D1", async () => {
    await expect(new Store(guardEnv.DB).insertPropagated("demo", [], Date.now())).resolves.toBeUndefined();
  });

  // Only a hash can be "removed": scheduling a ref changes a row too, but that is not a removal.
  it("unban by ref alone: removed is false", async () => {
    const app = `s${randomHash().slice(0, 12)}`;
    expect(await new Store(guardEnv.DB).unban(app, null, "A1B2C3D4", "token", Date.now())).toBe(false);
  });
});
