import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

// Throwaway P-256 key in the same format as Apple's .p8 (PKCS#8 in PEM).
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          ADMIN_TOKEN: "test-admin-token",
          APPLE_DC_KEY_P8_DEMO: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          TEST_PUBLIC_JWK: JSON.stringify(publicKey.export({ format: "jwk" })),
          // Second app, in observation mode, to check isolation.
          HASH_PREFIX_OTHER: "other-ban-v1",
          ENFORCE_OTHER: "false",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Stryker copies (sandbox or inPlace backup) left behind if a run is interrupted.
    exclude: [...configDefaults.exclude, ".stryker-tmp/**"],
  },
});
