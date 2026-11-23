import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShopifyGraphQLRequestError,
  backoffDelayMs,
  computeThrottleWaitMs,
  executeWithRetry,
  sleep,
} from "../app/services/shopify/client.server";

describe("computeThrottleWaitMs", () => {
  it("returns 0 when the budget covers the next call", () => {
    expect(
      computeThrottleWaitMs({ currentlyAvailable: 500, restoreRate: 50 }, 400),
    ).toBe(0);
  });

  it("computes the wait from the deficit and restore rate", () => {
    // deficit 100 points, 50 points/s -> 2s
    expect(
      computeThrottleWaitMs({ currentlyAvailable: 400, restoreRate: 50 }, 500),
    ).toBe(2000);
    // deficit 0.5 points, 100 points/s -> 5ms
    expect(
      computeThrottleWaitMs({ currentlyAvailable: 99.5, restoreRate: 100 }, 100),
    ).toBe(5);
  });

  it("returns 0 on unknown restore rate instead of hanging", () => {
    expect(
      computeThrottleWaitMs({ currentlyAvailable: 0, restoreRate: 0 }, 100),
    ).toBe(0);
  });
});

describe("backoffDelayMs", () => {
  it("doubles exponentially starting at 500ms", () => {
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(2)).toBe(1000);
    expect(backoffDelayMs(3)).toBe(2000);
    expect(backoffDelayMs(4)).toBe(4000);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("executeWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns data on the first try", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { hello: "world" } }));
    const result = await executeWithRetry<{ hello: string }>(send);
    expect(result.data).toEqual({ hello: "world" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx with backoff and succeeds", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 1 } }));
    const promise = executeWithRetry<{ ok: number }>(send);
    // Backoff sleeps (500ms + 1000ms) complete instantly under fake timers.
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result.data).toEqual({ ok: 1 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("retries a genuine network failure with backoff", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const promise = executeWithRetry<{ ok: boolean }>(send);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toMatchObject({ data: { ok: true } });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error after 5 failed attempts", async () => {
    const send = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    // Attach the rejection expectation BEFORE advancing timers so the
    // rejection is always handled (no unhandled-rejection warnings).
    const expectation = expect(executeWithRetry(send)).rejects.toThrow(
      ShopifyGraphQLRequestError,
    );
    // Real backoff would be 500+1000+2000+4000 = 7.5s; run it instantly.
    await vi.advanceTimersByTimeAsync(8000);
    await expectation;
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("waits per throttle status on THROTTLED responses, then succeeds", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: {
            cost: {
              requestedQueryCost: 100,
              throttleStatus: {
                currentlyAvailable: 0,
                maximumAvailable: 1000,
                restoreRate: 1000, // 1s to restore 1000
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 1 } }));

    const promise = executeWithRetry<{ ok: number }>(send, 100);
    // Pre-emptive throttle wait (100ms with this fake throttle status).
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result.data).toEqual({ ok: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("surfaces GraphQL errors as thrown errors with context", async () => {
    const send = vi.fn().mockResolvedValue(
      jsonResponse({
        errors: [{ message: "Field 'x' doesn't exist" }],
      }),
    );
    const error = await executeWithRetry(send).catch((e) => e);
    expect(error).toBeInstanceOf(ShopifyGraphQLRequestError);
    expect(error.message).toContain("Field 'x' doesn't exist");
    expect(send).toHaveBeenCalledTimes(1); // GraphQL errors are not retried
  });

  it("does not retry a Shopify GraphqlQueryError thrown by the admin client", async () => {
    const error = Object.assign(new Error("Field 'available' doesn't exist on type 'InventoryLevel'"), {
      name: "GraphqlQueryError",
      body: {
        errors: {
          graphQLErrors: [{ message: "Field 'available' doesn't exist on type 'InventoryLevel'" }],
        },
      },
    });
    const send = vi.fn().mockRejectedValue(error);

    await expect(executeWithRetry(send)).rejects.toThrow(
      "Field 'available' doesn't exist on type 'InventoryLevel'",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("throws when the response has no data", async () => {
    const send = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(executeWithRetry(send)).rejects.toThrow(/no data/i);
  });
});

describe("sleep", () => {
  it("resolves after the given delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
