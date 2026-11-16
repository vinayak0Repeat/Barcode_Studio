/**
 * Read-only DB round-trip measurement. Run with:
 *   node scripts/db-ping.mjs
 * Uses the app's Prisma client (respects DATABASE_URL from .env via
 * shopify's dotenv? NO — load it explicitly, safely, without printing it).
 */
import { PrismaClient } from "@prisma/client";

// Minimal .env loader (never prints values).
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
} catch {
  // no .env — rely on the environment
}

const prisma = new PrismaClient();

async function ping(label) {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  console.log(
    `${label}: min ${min.toFixed(1)}ms | median ${median.toFixed(1)}ms | max ${max.toFixed(1)}ms over 10 pings`,
  );
}

console.log("Measuring database round-trip time (SELECT 1)...");
await ping("cold  ");
await ping("warm  ");
await prisma.$disconnect();
