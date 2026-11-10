// JWT ES256 para la API de DeviceCheck (mismo procedimiento que el token de proveedor de APNs).

const REFRESH_AFTER_S = 30 * 60; // Apple rechaza un `iat` de más de una hora.

export const b64url = (input: ArrayBuffer | Uint8Array | string): string => {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  // Stryker disable next-line Regex: quitar el "$" es equivalente, en base64 el "=" solo va al final.
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function importP8(p8: string): Promise<CryptoKey> {
  const pem = p8.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

export async function signAppleJWT(
  key: CryptoKey,
  keyId: string,
  teamId: string,
  nowS: number,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: nowS }));
  // Web Crypto devuelve la firma ECDSA como r || s (64 bytes), el formato que pide JWS.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(sig)}`;
}

// Caché por isolate, por clave de Apple.
const cache = new Map<string, { jwt: string; iat: number }>();

export async function appleJWT(
  apple: { p8: string; keyId: string; teamId: string },
  nowS = Math.floor(Date.now() / 1000),
): Promise<string> {
  const cacheKey = `${apple.teamId}:${apple.keyId}`;
  const hit = cache.get(cacheKey);
  if (hit && nowS - hit.iat < REFRESH_AFTER_S) return hit.jwt;

  const jwt = await signAppleJWT(await importP8(apple.p8), apple.keyId, apple.teamId, nowS);
  cache.set(cacheKey, { jwt, iat: nowS });
  return jwt;
}
