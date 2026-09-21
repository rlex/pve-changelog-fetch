import { describe, it, expect, vi } from "vitest";
import {
  debounce,
  formatReleaseDate,
  listBullets,
  matchesPackageName,
  readCache,
  relativeAge,
  sortPackages,
  squashRows,
  writeCache,
  type CacheStorage,
} from "../src/lib";
import type { PackageEntry } from "../src/shared/types";

/** Minimal in-memory CacheStorage double for tests. */
function fakeStorage(seed: Record<string, string> = {}): CacheStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function pkg(name: string, version = "1.0", released: number | null = null): PackageEntry {
  return { name, version, arch: "all", section: "s", filename: "f", description: "", released };
}

describe("squashRows", () => {
  it("keeps the highest version per name", () => {
    const rows = [
      pkg("foo", "9.0.4"),
      pkg("foo", "9.2.12"),
      pkg("foo", "9.2.9"),
      pkg("bar", "1.0"),
    ];
    const out = squashRows(rows);
    expect(out.map((p) => `${p.name}@${p.version}`)).toEqual(["foo@9.2.12", "bar@1.0"]);
  });
});

describe("sortPackages", () => {
  it("sorts by name", () => {
    const rows = [pkg("zoo"), pkg("abc"), pkg("mid")];
    expect(sortPackages(rows, "name").map((p) => p.name)).toEqual(["abc", "mid", "zoo"]);
  });

  it("sorts recent by release date desc, unknown dates last", () => {
    const rows = [
      pkg("old", "1", 100),
      pkg("new", "1", 300),
      pkg("unk"),
      pkg("mid", "1", 200),
    ];
    expect(sortPackages(rows, "recent").map((p) => p.name)).toEqual(["new", "mid", "old", "unk"]);
  });

  it("does not mutate the input list", () => {
    const rows = [pkg("b"), pkg("a")];
    sortPackages(rows, "name");
    expect(rows.map((p) => p.name)).toEqual(["b", "a"]);
  });
});

describe("listBullets", () => {
  it("folds wrapped lines into their bullet", () => {
    expect(listBullets(["* first change", "continuation", "* second"])).toEqual([
      "first change continuation",
      "second",
    ]);
  });

  it("keeps standalone non-bullet lines as-is", () => {
    expect(listBullets(["plain line"])).toEqual(["plain line"]);
  });
});

describe("matchesPackageName", () => {
  it("is a prefix match by default, not substring", () => {
    expect(matchesPackageName("pve-qemu-kvm", "pve")).toBe(true);
    expect(matchesPackageName("libpve-common-perl", "pve")).toBe(false); // contains, not prefix
  });

  it("supports * and ? globs (anchored)", () => {
    expect(matchesPackageName("libpve-common-perl", "*pve*")).toBe(true);
    expect(matchesPackageName("pve-qemu-kvm", "pve*")).toBe(true);
    expect(matchesPackageName("pvea", "pve?")).toBe(true);
    expect(matchesPackageName("pve", "pve?")).toBe(false);
    expect(matchesPackageName("zfsutils-linux", "*pve*")).toBe(false);
  });

  it("supports OR via |", () => {
    expect(matchesPackageName("pve-qemu-kvm", "proxmox|*qemu*")).toBe(true);
    expect(matchesPackageName("pve-qemu-kvm", "pve*|zfs")).toBe(true); // prefix branch OR
    expect(matchesPackageName("lvm2", "proxmox|*qemu*")).toBe(false);
  });

  it("is case-insensitive and treats empty query as match-all", () => {
    expect(matchesPackageName("Pve-Qemu-Kvm", "pve")).toBe(true);
    expect(matchesPackageName("anything", "   ")).toBe(true);
  });
});

describe("relativeAge / formatReleaseDate", () => {
  const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

  it("scales from now to days", () => {
    expect(relativeAge(NOW - 5_000, NOW)).toBe("now");
    expect(relativeAge(NOW - 3 * 60_000, NOW)).toBe("3m ago");
    expect(relativeAge(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(relativeAge(NOW - 4 * 86_400_000, NOW)).toBe("4d ago");
    expect(relativeAge(NOW - 400 * 86_400_000, NOW)).toBe("1y ago");
  });

  it("prepends the UTC date", () => {
    const d = new Date(NOW - 4 * 86_400_000);
    expect(formatReleaseDate(d.getTime(), NOW)).toBe(`${d.toISOString().slice(0, 10)} · 4d ago`);
  });
});

describe("readCache / writeCache", () => {
  const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

  it("round-trips a value within TTL", () => {
    const s = fakeStorage();
    writeCache(s, "k", { a: 1 }, NOW);
    expect(readCache<{ a: number }>(s, "k", 60, NOW + 30_000)).toEqual({ a: 1 });
  });

  it("expires entries after the TTL and removes them", () => {
    const s = fakeStorage();
    writeCache(s, "k", { a: 1 }, NOW);
    expect(readCache(s, "k", 60, NOW + 61_000)).toBeNull();
    expect(s.map.has("k")).toBe(false);
  });

  it("returns null for missing or corrupt entries", () => {
    const s = fakeStorage({ corrupt: "{not json" });
    expect(readCache(s, "missing", 60)).toBeNull();
    expect(readCache(s, "corrupt", 60)).toBeNull();
  });
});

describe("debounce", () => {
  it("fires once, with the latest args, after the delay", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);
      debounced("a");
      debounced("b");
      debounced("c");
      vi.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("c");
    } finally {
      vi.useRealTimers();
    }
  });
});