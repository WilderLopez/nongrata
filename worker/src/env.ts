// Las claves por app (`<NOMBRE>_<APP>`) son dinámicas, así que no se tipan desde
// wrangler.jsonc: se leen con `appConfig`.
export interface GuardEnv {
  DB: D1Database;
  RATE_LIMITER?: RateLimit;
  ADMIN_TOKEN?: string;
  [key: string]: unknown;
}

export interface AppConfig {
  app: string;
  hashPrefix: string;
  enforce: boolean;
  /** Ausente si la app no tiene clave de DeviceCheck: se decide solo con D1. */
  apple?: { teamId: string; keyId: string; p8: string };
}

const APP_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const isAppId = (value: unknown): value is string =>
  typeof value === "string" && APP_RE.test(value);

/** `null` si la app no está configurada (sin `HASH_PREFIX_<APP>`). */
export function appConfig(env: GuardEnv, app: string): AppConfig | null {
  const suffix = app.toUpperCase().replace(/-/g, "_");
  const str = (name: string): string | undefined => {
    const v = env[`${name}_${suffix}`];
    // Stryker disable next-line EqualityOperator: un "" se descarta igual después (prefijo ausente, enforce falso, sin Apple).
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const hashPrefix = str("HASH_PREFIX");
  if (!hashPrefix) return null;

  const teamId = str("APPLE_TEAM_ID");
  const keyId = str("APPLE_KEY_ID");
  const p8 = str("APPLE_DC_KEY_P8");

  return {
    app,
    hashPrefix,
    enforce: str("ENFORCE") === "true",
    apple: teamId && keyId && p8 ? { teamId, keyId, p8 } : undefined,
  };
}
