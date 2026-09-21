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

/** Glob branch -> anchored regex. `*` = any run, `?` = one char; other chars literal. */
function globToRe(pattern: string): RegExp {
 let src = "";
 for (const ch of pattern) {
  if (ch === "*") src += ".*";
  else if (ch === "?") src += ".";
  else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 }
 return new RegExp(`^${src}$`);
}

/** "3h ago" style relative age. Deterministic for tests via the `now` param. */
export function relativeAge(ms: number, now = Date.now()): string {
 const s = Math.max(0, Math.floor((now - ms) / 1000));
 if (s < 60) return "now";
 const m = Math.floor(s / 60);
 if (m < 60) return `${m}m ago`;
 const h = Math.floor(m / 60);
 if (h < 24) return `${h}h ago`;
 const d = Math.floor(h / 24);
 if (d < 365) return `${d}d ago`;
 return `${Math.floor(d / 365)}y ago`;
}

/** "2026-09-18 · 3d ago" for a publish time. */
export function formatReleaseDate(ms: number, now = Date.now()): string {
 return `${new Date(ms).toISOString().slice(0, 10)} · ${relativeAge(ms, now)}`;
}

/** Case-insensitive package-name search. Branches split on `|` are OR'd; a branch with
 * `*`/`?` is a glob (anchored full match), otherwise it's a prefix match. */
export function matchesPackageName(name: string, query: string): boolean {
 if (!query.trim()) return true;
 const lower = name.toLowerCase();
 return query
  .split("|")
  .map((branch) => branch.trim())
  .filter((branch) => branch.length > 0)
  .some((branch) => {
   const norm = branch.toLowerCase();
   return /[*?]/.test(norm) ? globToRe(norm).test(lower) : lower.startsWith(norm);
  });
}