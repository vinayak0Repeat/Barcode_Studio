/**
 * PERF_LOG=true helper (default OFF). Wraps a loader/action body and logs
 * wall time + Prisma query counters around it. Only route name, duration
 * and counts are logged — never data, params or secrets. Also emits a
 * Server-Timing header via the returned headers when easy.
 */

const enabled = () => process.env.PERF_LOG === "true";

export async function withPerf<T>(
  route: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled()) {
    return fn();
  }
  global.prismaPerf = { queries: 0, totalMs: 0, byModel: {}, slowest: null };
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - start;
    const { queries, totalMs } = global.prismaPerf ?? {
      queries: 0,
      totalMs: 0,
    };
    console.log(
      `[perf:route] ${route}: ${elapsed.toFixed(0)}ms wall, ${queries} prisma queries (${totalMs.toFixed(1)}ms in db)`,
    );
  }
}

/** Server-Timing value for a measured loader (no-op unless PERF_LOG). */
export function perfHeader(route: string, elapsedMs: number): string {
  return `app;desc="${route}";dur=${elapsedMs.toFixed(0)}`;
}
