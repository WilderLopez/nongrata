---
tags: [concepto]
aliases: [Hash, ref, Código de soporte, Normalización, Prefijo]
---

# Hash y ref

## El hash

Ningún identificador se guarda en bruto. Se guarda su hash:

```
SHA256(prefijo + ":" + kind + ":" + valor normalizado)   → hex en minúsculas
```

Ejemplo: `myapp-ban-v1:idfv:5F3A…`.

- El **prefijo** es distinto por app (`HASH_PREFIX_MYAPP = myapp-ban-v1`). Así el mismo `idfv`
  da hashes distintos en dos apps y las listas no se mezclan.
- La fórmula es **idéntica** en el SDK, el Worker y la CLI. `spec/hash-vectors.json` tiene
  ejemplos que comprueban los tests de los tres.
- Cambiar la fórmula invalida todas las listas. Por eso la normalización se decidió **antes**
  del primer baneo real.

Para calcular un hash sin red: `pnpm ng hash prefix=myapp-ban-v1 kind=idfv value=…`.

## El ref

Los 8 primeros caracteres, en mayúsculas, del hash de `install`. Ejemplo: `A1B2C3D4`.

- Es el **código de soporte**: la pantalla de suspendido lo muestra y el usuario lo manda.
- Soporte desbanea con `pnpm ng unban app=myapp ref=A1B2C3D4`.
- El desbaneo es completo: en la siguiente comprobación de ese iPhone, el Worker pone `bit0` a
  false y borra de la lista todos los hashes que trae.
- El Worker calcula el `ref` él mismo; nunca se fía del que manda el cliente.

## Normalización (decidido el 2026-11-02)

Antes del hash, el valor se limpia igual en los tres sitios:

- Se quitan espacios, tabuladores y saltos de línea de los extremos (solo los ASCII).
- En `idfv` e `install`, que son UUID, las letras a-z pasan a mayúsculas.
- `icloud` y `user` se dejan como están: son opacos y distinguen mayúsculas.

Por qué: el SDK manda los UUID en mayúsculas (`uuidString`), pero un `idfv` copiado de otra
herramienta puede venir en minúsculas o con un espacio al final. Sin normalizar, ese baneo no
coincidiría nunca y nada avisaría.

Se descartó no normalizar y que solo la CLI avisara (un baneo hecho sin la CLI seguiría fallando)
y pasarlo todo a minúsculas (alteraría `icloud` y `user`).

En código: `normalizeValue` en `worker/src/hash.ts` (lo usa también la CLI) e
`IdentifierHasher.normalize` en Swift. Los vectores con `note` en `spec/hash-vectors.json`
cubren cada regla.

Diseño: secciones 8.2 y 16 (pendiente 9) del [HANDOFF](../HANDOFF.md).
