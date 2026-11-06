import { defineConfig } from "vitest/config";

// Ordinary run: deterministic tests only. Live tests live in tests/live and are
// excluded here; run them explicitly with `pnpm test:live`.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/live/**"] },
});
