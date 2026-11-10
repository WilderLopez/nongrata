import { describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { guardEnv } from "./helpers";

describe("Store", () => {
  it("anyBanned with no hashes: never banned", async () => {
    expect(await new Store(guardEnv.DB).anyBanned("demo", [])).toBe(false);
  });

  // D1 rejects an empty batch ("No SQL statements detected"): the guard is required.
  it("insertPropagated with no identifiers does not call D1", async () => {
    await expect(new Store(guardEnv.DB).insertPropagated("demo", [], Date.now())).resolves.toBeUndefined();
  });
});
