import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      ADMIN_TOKEN: string;
      APPLE_DC_KEY_P8_DEMO: string;
      TEST_PUBLIC_JWK: string;
      HASH_PREFIX_OTHER: string;
      ENFORCE_OTHER: string;
    }
  }
}
