import { describe, it, expect } from "vitest";
import { sortPackages, squashRows, listBullets } from "../src/lib";
import type { PackageEntry } from "../src/shared/types";

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