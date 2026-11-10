---
tags: [concepto]
aliases: [propagated, Propagado]
---

# Propagación

Cuando un dispositivo sale bloqueado, el Worker guarda en la lista **los hashes nuevos** que trae
esa petición, con `reason = propagated`. El sistema se refuerza solo.

## Por qué importa

Ejemplo con el actor del caso real:

1. Baneas a mano el `idfv` de su iPhone A.
2. Abre la app en A: bloqueado. El Worker escribe `bit0` y guarda como `propagated` su
   `install` y su `icloud`.
3. Coge el iPhone B, con la **misma cuenta de Apple**. Su `icloud` ya está en la lista:
   bloqueado, sin que tú hagas nada. Y ahora también se guardan el `idfv` y el `install` de B.

Sin propagación habría que encontrar y banear a mano cada identificador de cada iPhone.

## Reglas

- Se aplica a cualquier bloqueo, venga de un hash o de `bit0`, pero solo con `ENFORCE` activo:
  en [modo observación](fail-open-y-observacion.md) no se propaga.
- Nunca pisa una marca `manual`.
- El desbaneo por `ref` borra los hashes de ese dispositivo, incluidos los propagados.
- Caso delicado: una pareja que comparte cuenta de Apple. Se arregla retirando solo el hash
  `icloud` con `pnpm ng unban app=myapp kind=icloud hash=…`.

Ver también [Flujo de una comprobación](flujo-de-check.md) e [Identificadores](identificadores.md).
Diseño: secciones 5 y 6 del [HANDOFF](../HANDOFF.md).
