import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@priceradar/domain": path.resolve(rootDir, "packages/domain/src/index.ts"),
      "@priceradar/providers": path.resolve(rootDir, "packages/providers/src/index.ts"),
      "@priceradar/database": path.resolve(rootDir, "packages/database/src/index.ts"),
      "@priceradar/ui": path.resolve(rootDir, "packages/ui/src/index.ts"),
      "@priceradar/config": path.resolve(rootDir, "packages/config/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
    passWithNoTests: false,
  },
});
