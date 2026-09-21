import { describe, it, expect } from "vitest";
import { MemoryCache } from "../src/core/core";

describe("MemoryCache", () => {
  it("bounds size with FIFO eviction", async () => {
    const cache = new MemoryCache(5);
    for (let i = 0; i < 10; i++) await cache.put(`u${i}`, { body: String(i), fetchedAt: 0 });

    await expect(cache.get("u0")).resolves.toBeNull(); // oldest evicted
    await expect(cache.get("u9")).resolves.toEqual({ body: "9", fetchedAt: 0 }); // newest kept

    let kept = 0;
    for (let i = 0; i < 10; i++) if (await cache.get(`u${i}`)) kept++;
    expect(kept).toBe(5);
  });

  it("refreshes insertion order on re-put", async () => {
    const cache = new MemoryCache(2);
    await cache.put("a", { body: "a", fetchedAt: 0 });
    await cache.put("b", { body: "b", fetchedAt: 0 });
    await cache.put("a", { body: "a2", fetchedAt: 0 }); // a refreshed -> newest
    await cache.put("c", { body: "c", fetchedAt: 0 }); // evicts oldest = b

    await expect(cache.get("a")).resolves.toEqual({ body: "a2", fetchedAt: 0 });
    await expect(cache.get("b")).resolves.toBeNull();
    await expect(cache.get("c")).resolves.toEqual({ body: "c", fetchedAt: 0 });
  });
});