---
tags: [concepto]
aliases: [Stryker, Mutantes, Mutation score]
---

# Mutation testing

*English: [mutation-testing.md](../../concepts/mutation-testing.md)*

Una forma de medir si los tests **de verdad** vigilan el código, no solo si lo ejecutan.

## La idea

1. Stryker cambia el código a propósito, un cambio pequeño cada vez (un "mutante"): `>` por
   `>=`, `true` por `false`, borra una línea…
2. Corre los tests contra cada mutante.
3. Si algún test falla, el mutante está **muerto**: bien, los tests notaron el cambio.
4. Si todos pasan, el mutante **sobrevive**: hay un comportamiento que ningún test comprueba.

El **score** es el porcentaje de mutantes muertos.

## En este repo

| Paquete | Score | Supervivientes |
|---|---|---|
| Worker | 99,5 % | 3 (equivalentes: el cambio no altera el comportamiento) |
| CLI | 100 % | 0 (1 equivalente marcado en el código) |
| SDK Swift | sin herramienta automática | 0 de 17 en una pasada a mano (2026-11-05) |

- `make mutation` lo corre y falla si el score baja más de un punto respecto al baseline
  (`<paquete>/mutation-baseline.json`).
- Informe navegable: `worker/reports/mutation/index.html` (y lo mismo en `cli/`).
- Un mutante que no se puede matar se marca en el código con
  `// Stryker disable next-line <Mutator>: <motivo>`, nunca con un test de relleno.
- Stryker modifica `src/` mientras corre y lo restaura al final: no edites código a la vez.

Para Swift se probó Muter (2026-11-05) y no sirve todavía: la versión publicada (16) no compila
con Swift 6.4, y la de la rama principal no mete los mutantes en la build que prueba, así que
los da todos por supervivientes. Sus 17 mutantes se pasaron a mano con `swift test`: 16 muertos,
y el otro tiene ahora su test.

Configuración: `worker/stryker.config.json`, `cli/stryker.config.json` y
`scripts/mutation-score.mjs`.
