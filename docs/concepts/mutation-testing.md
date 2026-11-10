---
tags: [concept]
aliases: [Stryker, Mutants, Mutation score]
---

# Mutation testing

*Español: [mutation-testing.md](../es/conceptos/mutation-testing.md)*

A way to measure whether the tests **really** guard the code, not just whether they run it.

## The idea

1. Stryker changes the code on purpose, one small change at a time (a "mutant"): `>` for `>=`,
   `true` for `false`, deleting a line…
2. It runs the tests against each mutant.
3. If any test fails, the mutant is **killed**: good, the tests noticed the change.
4. If they all pass, the mutant **survives**: there is a behavior no test checks.

The **score** is the percentage of killed mutants.

## In this repo

| Package | Score | Survivors |
|---|---|---|
| Worker | 99.5% | 3 (equivalent: the change doesn't alter behavior) |
| CLI | 100% | 0 (1 equivalent marked in the code) |
| Swift SDK | no automatic tool | 0 of 17 in a manual pass (2026-11-05) |

- `make mutation` runs it and fails if the score drops more than one point below the baseline
  (`<package>/mutation-baseline.json`).
- Browsable report: `worker/reports/mutation/index.html` (and the same in `cli/`).
- A mutant that cannot be killed is marked in the code with
  `// Stryker disable next-line <Mutator>: <reason>`, never with a filler test.
- Stryker modifies `src/` while it runs and restores it at the end: don't edit code at the same
  time.

For Swift, Muter was tried (2026-11-05) and doesn't work yet: the released version (16) doesn't
compile with Swift 6.4, and the one on the main branch doesn't put the mutants into the build it
tests, so it reports them all as survivors. Its 17 mutants were run by hand with `swift test`:
16 killed, and the other one now has its test.

Configuration: `worker/stryker.config.json`, `cli/stryker.config.json` and
`scripts/mutation-score.mjs`.
