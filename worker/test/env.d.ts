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
      HASH_PREFIX_LINKED: string;
      ENFORCE_LINKED: string;
      LINK_USERS_LINKED: string;
      HASH_PREFIX_LINKEDOBS: string;
      ENFORCE_LINKEDOBS: string;
      LINK_USERS_LINKEDOBS: string;
    }
  }
}
