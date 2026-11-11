---
tags: [concept]
aliases: [propagated, Propagated]
---

# Propagation

*Español: [propagacion.md](../es/conceptos/propagacion.md)*

When a device comes out blocked, the Worker stores in the list **the new hashes** that request
carries, with `reason = propagated`. The system reinforces itself.

## Why it matters

Example with the actor from the real case:

1. You manually ban the `idfv` of their iPhone A.
2. They open the app on A: blocked. The Worker writes `bit0` and stores its `install` and its
   `icloud` as `propagated`.
3. They pick up iPhone B, with the **same Apple account**. Its `icloud` is already on the list:
   blocked, without you doing anything. And now B's `idfv` and `install` are stored too.

Without propagation, you would have to find and manually ban every identifier of every iPhone.

## Rules

- It applies to any block, whether it comes from a hash or from `bit0`, but only with `ENFORCE`
  on: in [observation mode](fail-open-and-observation.md) there is no propagation.
- It never overwrites a `manual` entry.
- Each propagated row keeps the `ref` of the device that added it, so an unban by `ref` deletes
  that device's propagated hashes at once; the rest of its hashes go on its next check.
- Tricky case: a couple who share an Apple account. It is fixed by removing only the `icloud`
  hash with `pnpm ng unban app=myapp kind=icloud hash=…`.

See also [Check flow](check-flow.md) and [Identifiers](identifiers.md).
Design: sections 5 and 6 of [DESIGN.md](../DESIGN.md).
