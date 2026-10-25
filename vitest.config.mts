import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    server: {
      deps: {
        // next-auth imports "next/server" without an extension, which only a bundler resolves
        // (Next has no package exports); letting Vite process it makes it load in tests.
        inline: ["next-auth"],
      },
    },
  },
});
