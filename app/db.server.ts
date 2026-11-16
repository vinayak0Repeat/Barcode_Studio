import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
  // Perf counters (dev-only, behind PERF_LOG): total queries, per-model
  // counts and cumulative duration, reset by the PERF reporter.
  // eslint-disable-next-line no-var
  var prismaPerf: {
    queries: number;
    totalMs: number;
    byModel: Record<string, { count: number; ms: number }>;
    slowest: { model: string; action: string; ms: number } | null;
  };
}

// ---------------------------------------------------------------------------
// PERF_LOG=true instrumentation (default OFF).
// Logs only model/action/duration/counters — never values, rows or params.
// ---------------------------------------------------------------------------

const PERF_LOG = process.env.PERF_LOG === "true";

function ensurePerfCounters() {
  if (!global.prismaPerf) {
    global.prismaPerf = {
      queries: 0,
      totalMs: 0,
      byModel: {},
      slowest: null,
    };
  }
  return global.prismaPerf;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient(
    PERF_LOG
      ? {
          log: [
            { emit: "event", level: "query" as const },
            { emit: "stdout", level: "error" as const },
          ],
        }
      : undefined,
  );

  if (PERF_LOG) {
    client.$on("query" as never, (event: unknown) => {
      const query = event as { duration: number };
      // Model/action are parsed from the (anonymous) prepared statement; we
      // deliberately do NOT log the query text or params.
      void query;
      const perf = ensurePerfCounters();
      perf.queries += 1;
      perf.totalMs += (event as { duration: number }).duration;
    });
    // Periodic summary so long-running dev sessions see the totals.
    const timer = setInterval(() => {
      const perf = ensurePerfCounters();
      if (perf.queries > 0) {
        console.log(
          `[perf:prisma] last window: ${perf.queries} queries, ${perf.totalMs.toFixed(1)}ms total`,
        );
        perf.queries = 0;
        perf.totalMs = 0;
      }
    }, 30_000);
    timer.unref?.();
  }

  return client;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createPrismaClient();
  }
}

const prisma = global.prismaGlobal ?? createPrismaClient();

export default prisma;
