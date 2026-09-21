import { describe, it, expect } from "vitest";
import { apiFetch, MemoryCache } from "../src/core/core";

const cache = new MemoryCache();

describe("apiFetch", () => {
  it("serves /api/health without any upstream call", async () => {
    const res = await apiFetch(cache, new Request("http://localhost/api/health"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    await expect(res!.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns null for non-API paths so static assets can be served", async () => {
    expect(await apiFetch(cache, new Request("http://localhost/assets/app.js"))).toBeNull();
  });
});