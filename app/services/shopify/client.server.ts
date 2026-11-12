import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Small wrapper around an admin GraphQL client with throttle handling:
 * - reads extensions.cost.throttleStatus and pre-emptively waits when the
 *   next call could exceed the available budget,
 * - retries THROTTLED responses and transient 5xx with exponential backoff,
 * - surfaces GraphQL errors / userErrors as thrown errors with context.
 *
 * Keep each query under the 1,000-point per-query cap (choose page sizes
 * accordingly).
 */

export const MAX_ATTEMPTS = 5;
export const QUERY_COST_CAP = 1000;
/** Conservative default estimate when the API doesn't report a cost. */
export const DEFAULT_ESTIMATED_COST = 200;

export interface ThrottleStatus {
  currentlyAvailable: number;
  maximumAvailable: number;
  restoreRate: number;
}

export interface CostInfo {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: ThrottleStatus;
}

export class ShopifyGraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "ShopifyGraphQLRequestError";
  }
}

/** ms to wait until `nextCost` points are available again (0 = no wait). */
export function computeThrottleWaitMs(
  status: Pick<ThrottleStatus, "currentlyAvailable" | "restoreRate">,
  nextCost: number,
): number {
  if (nextCost <= status.currentlyAvailable) return 0;
  if (status.restoreRate <= 0) return 0; // unknown restore rate; don't hang
  const deficit = nextCost - status.currentlyAvailable;
  return Math.ceil((deficit / status.restoreRate) * 1000);
}

/** Exponential backoff: 500ms, 1s, 2s, 4s, ... */
export function backoffDelayMs(attempt: number): number {
  return 500 * 2 ** Math.max(0, attempt - 1);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GraphQLBody {
  data?: unknown;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: CostInfo };
}

/** Extracts a throttle status from a THROTTLED error, if present. */
function throttledStatus(body: GraphQLBody): ThrottleStatus | undefined {
  return body.errors?.some((e) => e.extensions?.code === "THROTTLED")
    ? body.extensions?.cost?.throttleStatus
    : undefined;
}

/**
 * Core executor. `send` must perform one GraphQL request and return the raw
 * Response (so this is testable with fakes, no network).
 */
export async function executeWithRetry<TData>(
  send: () => Promise<Response>,
  estimatedCost: number = DEFAULT_ESTIMATED_COST,
): Promise<{ data: TData; cost: CostInfo }> {
  let lastThrottle: ThrottleStatus | undefined;
  let nextCost = estimatedCost;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (lastThrottle) {
      const waitMs = computeThrottleWaitMs(lastThrottle, nextCost);
      if (waitMs > 0) await sleep(waitMs);
    }

    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        throw new ShopifyGraphQLRequestError(
          `GraphQL request failed after ${MAX_ATTEMPTS} attempts (network error)`,
          error,
        );
      }
      await sleep(backoffDelayMs(attempt));
      continue;
    }

    if (response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new ShopifyGraphQLRequestError(
          `GraphQL request failed with HTTP ${response.status} after ${MAX_ATTEMPTS} attempts`,
          { status: response.status },
        );
      }
      await sleep(backoffDelayMs(attempt));
      continue;
    }

    const body = (await response.json()) as GraphQLBody;
    const cost = body.extensions?.cost ?? {};
    if (cost.throttleStatus) lastThrottle = cost.throttleStatus;
    if (cost.requestedQueryCost) nextCost = cost.requestedQueryCost;

    const throttle = throttledStatus(body);
    if (throttle) {
      lastThrottle = throttle;
      if (attempt === MAX_ATTEMPTS) {
        throw new ShopifyGraphQLRequestError(
          "GraphQL request still THROTTLED after retries",
          body.errors,
        );
      }
      continue; // no backoff sleep; the next loop waits per throttle status
    }

    if (body.errors?.length) {
      // GraphQL validation/runtime errors on an HTTP 200 response are
      // permanent — never retried and never labelled as a network error.
      throw new ShopifyGraphQLRequestError(
        `GraphQL request rejected with errors (not retried): ${body.errors
          .map((e) => e.message)
          .join("; ")}`,
        body.errors,
      );
    }

    if (body.data == null) {
      throw new ShopifyGraphQLRequestError(
        "GraphQL response contained no data",
        body,
      );
    }

    return { data: body.data as TData, cost };
  }

  // Unreachable, but keeps TS happy.
  throw new ShopifyGraphQLRequestError("GraphQL request failed", null);
}

/**
 * Runs a query against an admin GraphQL client with throttle handling.
 * `estimatedCost` is used for the pre-emptive wait of the *first* call in a
 * chain; afterwards the reported requestedQueryCost is used.
 */
export async function adminGraphQL<TData>(
  admin: AdminApiContext,
  query: string,
  variables?: Record<string, unknown>,
  estimatedCost: number = DEFAULT_ESTIMATED_COST,
): Promise<TData> {
  const { data } = await executeWithRetry<TData>(
    () => admin.graphql(query, { variables }),
    estimatedCost,
  );
  return data;
}

/** Throws when a mutation returned userErrors. */
export function throwUserErrors(
  context: string,
  userErrors: Array<{ message?: string; field?: string[] }> | undefined,
): void {
  if (userErrors && userErrors.length > 0) {
    throw new ShopifyGraphQLRequestError(
      `${context}: ${userErrors.map((e) => e.message).join("; ")}`,
      userErrors,
    );
  }
}
