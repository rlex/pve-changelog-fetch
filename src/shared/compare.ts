/** Naive Debian-ish version comparison. Returns >0 if `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .split(/[.~+-]/)
      .map((part) => (/^\d+$/.test(part) ? part.padStart(12, "0") : part))
      .join("\u0000");
  return norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0;
}