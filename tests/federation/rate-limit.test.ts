// API-9 / api-design.md §Rate Limiting: the token bucket, and the limiter built on it.
import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter, takeToken, type Bucket, type RateLimit } from "@/federation";

const LIMIT: RateLimit = { capacity: 500, perHour: 500 };
const T0 = Date.parse("2026-09-19T12:00:00Z");

describe("the token bucket", () => {
  it("a partner never seen before starts with a full bucket: a first full sync can burst", () => {
    let bucket: Bucket | undefined;
    for (let request = 0; request < 500; request++) {
      const taken = takeToken(bucket, LIMIT, T0);
      expect(taken.decision.allowed).toBe(true);
      bucket = taken.bucket;
    }
    expect(takeToken(bucket, LIMIT, T0).decision).toEqual({ allowed: false, retryAfterSeconds: 8 });
  });

  it("refills at the hourly rate: 500 an hour is one request every 7.2 seconds", () => {
    const empty: Bucket = { tokens: 0, at: T0 };
    expect(takeToken(empty, LIMIT, T0 + 7_100).decision.allowed).toBe(false);
    expect(takeToken(empty, LIMIT, T0 + 7_200).decision.allowed).toBe(true);
  });

  it("says how long to wait, rounded up and never zero", () => {
    expect(takeToken({ tokens: 0, at: T0 }, LIMIT, T0).decision).toEqual({ allowed: false, retryAfterSeconds: 8 });
    expect(takeToken({ tokens: 0.999, at: T0 }, LIMIT, T0).decision).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(takeToken({ tokens: 0, at: T0 }, { capacity: 10, perHour: 60 }, T0).decision).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("a refused request costs nothing, so waiting the stated time is always enough", () => {
    const refused = takeToken({ tokens: 0, at: T0 }, LIMIT, T0);
    const { retryAfterSeconds } = refused.decision as { retryAfterSeconds: number };
    expect(takeToken(refused.bucket, LIMIT, T0 + retryAfterSeconds * 1000).decision.allowed).toBe(true);
  });

  it("never holds more than its capacity, however long a partner stays away", () => {
    const { bucket } = takeToken({ tokens: 3, at: T0 }, LIMIT, T0 + 30 * 24 * 3_600_000);
    expect(bucket.tokens).toBe(499);
  });

  it("a clock that steps backwards refills nothing and breaks nothing", () => {
    expect(takeToken({ tokens: 0, at: T0 }, LIMIT, T0 - 60_000).decision.allowed).toBe(false);
  });
});

describe("the in-memory limiter", () => {
  it("counts each partner separately", async () => {
    const limiter = new InMemoryRateLimiter({ now: () => new Date(T0) });
    const small: RateLimit = { capacity: 2, perHour: 60 };
    expect(await limiter.take("alpha.example", small)).toEqual({ allowed: true });
    expect(await limiter.take("alpha.example", small)).toEqual({ allowed: true });
    expect(await limiter.take("alpha.example", small)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(await limiter.take("beta.example", small)).toEqual({ allowed: true });
  });

  it("lets a partner back in as time passes", async () => {
    let now = T0;
    const limiter = new InMemoryRateLimiter({ now: () => new Date(now) });
    const small: RateLimit = { capacity: 1, perHour: 60 };
    await limiter.take("alpha.example", small);
    expect((await limiter.take("alpha.example", small)).allowed).toBe(false);
    now += 60_000;
    expect((await limiter.take("alpha.example", small)).allowed).toBe(true);
  });

  it("does not grow without bound when keys are whatever a caller sends", async () => {
    const limiter = new InMemoryRateLimiter({ now: () => new Date(T0) }, 100);
    const small: RateLimit = { capacity: 1, perHour: 1 };
    await limiter.take("kept.example", small);
    for (let index = 0; index < 1000; index++) {
      await limiter.take(`flood-${index}.example`, small);
      // Still in use, so still remembered: it is the idle buckets that go.
      if (index % 50 === 0) await limiter.take("kept.example", small);
    }
    expect((await limiter.take("kept.example", small)).allowed).toBe(false);
    expect((await limiter.take("flood-0.example", small)).allowed).toBe(true);
  });
});
