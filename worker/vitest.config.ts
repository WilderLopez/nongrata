import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

// Clave P-256 de usar y tirar con el mismo formato que el .p8 de Apple (PKCS#8 en PEM).
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
          // Segunda app para comprobar el aislamiento, en modo observación.
          HASH_PREFIX_OTHER: "other-ban-v1",
          ENFORCE_OTHER: "false",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Copias de Stryker (sandbox o backup de inPlace) si una corrida se interrumpe.
    exclude: [...configDefaults.exclude, ".stryker-tmp/**"],
  },
});
