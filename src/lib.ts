import type { PackageEntry } from "./shared/types";
import { compareVersions } from "./shared/compare";

export type SortMode = "recent" | "name";

/** Collapse to the highest version of each package name. */
export function squashRows(rows: PackageEntry[]): PackageEntry[] {
  const best = new Map<string, PackageEntry>();
  for (const p of rows) {
    const prev = best.get(p.name);
    if (!prev || compareVersions(p.version, prev.version) > 0) best.set(p.name, p);
  }
  return [...best.values()];
}

/** Sort packages by mode: "recent" = release date desc (unknown last), tie = name; else name. */
export function sortPackages(list: PackageEntry[], mode: SortMode): PackageEntry[] {
  if (mode === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
  return [...list].sort((a, b) => {
    const da = a.released ?? -Infinity;
    const db = b.released ?? -Infinity;
    if (da !== db) return db - da;
    return a.name.localeCompare(b.name);
  });
}

/** Fold wrapped changelog lines back into bullet items. */
export function listBullets(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    if (line.startsWith("*")) {
      bullets.push(line.replace(/^\*\s*/, ""));
    } else if (bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${line}`;
    } else {
      bullets.push(line);
    }
  }
  return bullets;
}