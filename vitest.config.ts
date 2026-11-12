import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      // Some modules under test instantiate PrismaClient at import time; they
      // never connect in unit tests, but the constructor validates that the
      // env var exists. Placeholder only — never a real connection.
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder",
    },
  },
});
