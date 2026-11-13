import { describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { guardEnv, randomHash } from "./helpers";

describe("Store", () => {
  it("anyBanned with no hashes: never banned", async () => {
    expect(await new Store(guardEnv.DB).anyBanned("demo", [])).toBe(false);
  });

  // D1 rejects an empty batch ("No SQL statements detected"): the guard is required.
  it("insertPropagated with no identifiers does not call D1", async () => {
    await expect(new Store(guardEnv.DB).insertPropagated("demo", "ABCDEF12", [], Date.now())).resolves.toBeUndefined();
  });

  // runCheck cancels the unban when it sees a newer manual ban; this covers one that arrives
  // between that look and the delete.
  it("removeHashes keeps a manual ban newer than the unban and removes the rest", async () => {
    const store = new Store(guardEnv.DB);
    const [older, newer, automatic] = [randomHash(), randomHash(), randomHash()];
    await store.banManual("demo", { kind: "idfv", hash: older }, null, "token", 1000);
    await store.banManual("demo", { kind: "user", hash: newer }, null, "token", 3000);
    await store.insertPropagated("demo", "ABCDEF12", [{ kind: "icloud", hash: automatic }], 3000);

    await store.removeHashes("demo", [older, newer, automatic], 2000);

    expect(await store.getBanned("demo", older)).toBeNull();
    expect(await store.getBanned("demo", automatic)).toBeNull();
    expect(await store.getBanned("demo", newer)).toMatchObject({ reason: "manual" });
  });

  // Only a hash can be "removed": scheduling a ref changes a row too, but that is not a removal.
  it("unban by ref alone: removed is false", async () => {
    const app = `s${randomHash().slice(0, 12)}`;
    expect(await new Store(guardEnv.DB).unban(app, null, "A1B2C3D4", "token", Date.now())).toBe(false);
  });
});
