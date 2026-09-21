import { describe, it, expect } from "vitest";
import {
  parseRelease,
  parsePackages,
  parseChangelog,
  letterDir,
  binaryListingDates,
  inflateIfGzip,
} from "../worker/parse";
import { compareVersions } from "../src/shared/compare";

describe("parseRelease", () => {
  it("extracts fields and skips checksum continuation lines", () => {
    const t = [
      "Architectures: amd64 arm64",
      "Changelogs: https://example.test/@CHANGEPATH@.changelog",
      "Codename: trixie",
      "Suite: stable",
      "Date: Mon, 21 Sep 2026 00:00:00 +0000",
      "Components: no-subscription test",
      "MD5Sum:",
      " abc123 something",
      "SHA256:",
      " def456 something",
    ].join("\n");
    expect(parseRelease(t)).toEqual({
      codename: "trixie",
      suite: "stable",
      date: "Mon, 21 Sep 2026 00:00:00 +0000",
      architectures: ["amd64", "arm64"],
      components: ["no-subscription", "test"],
      changelogsTemplate: "https://example.test/@CHANGEPATH@.changelog",
    });
  });

  it("defaults missing scalar fields to empty", () => {
    expect(parseRelease("Codename: x\n")).toEqual({
      codename: "x",
      suite: "",
      date: "",
      architectures: [],
      components: [],
      changelogsTemplate: "",
    });
  });
});

describe("parsePackages", () => {
  it("parses fields and folds the multi-line description to its first line", () => {
    const t = [
      "Package: foo",
      "Version: 1.2-3",
      "Architecture: all",
      "Section: admin",
      "Filename: dists/x/main/binary-all/foo_1.2-3_all.deb",
      "Source: foosrc",
      "Description: Short description",
      " Longer detail line one",
      " line two",
      "",
      "Package: bar",
      "Version: 2.0",
      "Architecture: amd64",
      "Section: misc",
      "Filename: dists/x/main/binary-amd64/bar_2.0_amd64.deb",
      "Description: Bar",
      "",
    ].join("\n");
    const [foo, bar] = parsePackages(t);
    expect(foo).toEqual({
      name: "foo",
      version: "1.2-3",
      arch: "all",
      section: "admin",
      filename: "dists/x/main/binary-all/foo_1.2-3_all.deb",
      source: "foosrc",
      description: "Short description",
      released: null,
    });
    expect(bar).toMatchObject({ name: "bar", version: "2.0" });
    expect(bar.source).toBeUndefined();
  });

  it("keeps every version row (no dedup here)", () => {
    const t = [
      "Package: foo", "Version: 1.0", "Architecture: all", "Section: s", "Filename: f1", "Description: d",
      "",
      "Package: foo", "Version: 1.1", "Architecture: all", "Section: s", "Filename: f2", "Description: d",
      "",
    ].join("\n");
    expect(parsePackages(t).map((p) => p.version)).toEqual(["1.0", "1.1"]);
  });
});

describe("parseChangelog", () => {
  const body = [
    "foo (1.2-3) trixie; urgency=medium",
    "",
    "  * first change",
    "  continuation of first",
    "  * second change",
    "",
    " -- Dev <dev@example.com>  Thu, 20 Aug 2026 23:19:02 +0200",
    "",
    "foo (1.0-1) trixie; urgency=low",
    "",
    "  * older change",
    "",
    " -- Dev <dev@example.com>  Mon, 01 Jan 2024 10:00:00 +0100",
  ].join("\n");

  it("parses entries newest-first with header/footer fields", () => {
    const entries = parseChangelog(body, "foo");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      version: "1.2-3",
      codename: "trixie",
      urgency: "medium",
      maintainer: "Dev <dev@example.com>",
      date: "Thu, 20 Aug 2026 23:19:02 +0200",
    });
    expect(entries[0].changes).toEqual(["* first change", "continuation of first", "* second change"]);
    expect(entries[1].version).toBe("1.0-1");
    expect(entries[1].urgency).toBe("low");
  });

  it("handles tilde versions", () => {
    const t = "foo (9.0.0~7) trixie; urgency=medium\n\n  * x\n\n -- D <d@e>  Thu, 20 Aug 2026 23:19:02 +0200\n";
    expect(parseChangelog(t, "foo")[0].version).toBe("9.0.0~7");
  });
});

describe("letterDir", () => {
  it("groups lib* into lib<letter>, everything else by first letter", () => {
    expect(letterDir("pve-qemu-kvm")).toBe("p");
    expect(letterDir("libpve-common-perl")).toBe("libp");
    expect(letterDir("lvm2")).toBe("l");
    expect(letterDir("rust-proxmox-mail-forward")).toBe("r");
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("9.2.10", "9.2.9")).toBeGreaterThan(0);
    expect(compareVersions("5.2.10", "5.2.2")).toBeGreaterThan(0);
    expect(compareVersions("6.14.11-10", "6.14.11-1")).toBeGreaterThan(0);
    expect(compareVersions("10.0.2-4", "11.0.0-1")).toBeLessThan(0);
    expect(compareVersions("9.2.12", "9.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0")).toBe(0);
  });
});

describe("binaryListingDates", () => {
  it("parses .deb rows, URL-decodes %2B, ignores other entries", () => {
    const html = [
      '<a href="../">../</a>',
      '<a href="foo_1.0_all.deb">foo_1.0_all.deb</a>  05-Aug-2025 12:19               100',
      '<a href="bar_2%2B1_amd64.deb">bar_2+1_amd64.deb</a>  19-Jan-2026 17:02       200',
      '<a href="Packages">Packages</a>  21-Sep-2026 09:26                         1000',
    ].join("\n");
    const dates = binaryListingDates(html);
    expect(dates.size).toBe(2);
    expect(dates.get("foo_1.0_all.deb")).toBe(Date.UTC(2025, 7, 5, 12, 19));
    expect(dates.get("bar_2+1_amd64.deb")).toBe(Date.UTC(2026, 0, 19, 17, 2));
  });
});

describe("inflateIfGzip", () => {
  // gzip(bytes) of the exact string "Package: foo\n" (mtime 0), precomputed.
  const GZIP_FOO = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 0, 19, 11, 72, 76, 206, 78, 76, 79, 181, 82, 72, 203, 207, 231, 2, 0, 86, 176, 214, 38, 13, 0, 0, 0]);

  it("decompresses a gzip stream", async () => {
    expect(await inflateIfGzip(GZIP_FOO)).toBe("Package: foo\n");
  });

  it("passes through already-decompressed bytes instead of throwing", async () => {
    const plain = new TextEncoder().encode("Package: foo\n");
    expect(await inflateIfGzip(plain)).toBe("Package: foo\n");
  });

  it("passes through arbitrary non-gzip bytes as text", async () => {
    const html = new TextEncoder().encode("<html>error</html>");
    expect(await inflateIfGzip(html)).toBe("<html>error</html>");
  });
});