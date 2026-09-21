import type { ReleaseFields, PackageEntry, ChangelogEntry } from "../src/shared/types";

const MONTHS: Record<string, number> = {
 Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
 Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export function parseRelease(text: string): ReleaseFields {
 const kv: Record<string, string> = {};
 for (const line of text.split(/\r?\n/)) {
  // Skip continuation lines (checksum lists and wrapped values).
  if (line.length === 0 || line[0] === " " || line[0] === "\t") continue;
  const idx = line.indexOf(":");
  if (idx < 0) continue;
  kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
 }
 return {
  codename: kv["Codename"] ?? "",
  suite: kv["Suite"] ?? "",
  date: kv["Date"] ?? "",
  architectures: (kv["Architectures"] ?? "").split(/\s+/).filter(Boolean),
  components: (kv["Components"] ?? "").split(/\s+/).filter(Boolean),
  changelogsTemplate: kv["Changelogs"] ?? "",
 };
}

export function parsePackages(text: string): PackageEntry[] {
 const entries: PackageEntry[] = [];
 let cur: (Omit<PackageEntry, "description" | "released"> & { desc: string[] }) | null = null;

 const flush = () => {
  if (!cur) return;
  const description = cur.desc.join("\n").replace(/\n+$/, "").split("\n")[0] ?? "";
  entries.push({
   name: cur.name,
   version: cur.version,
   arch: cur.arch,
   section: cur.section,
   filename: cur.filename,
   ...(cur.source ? { source: cur.source } : {}),
   description,
   released: null,
  });
  cur = null;
 };

 for (const raw of text.split(/\r?\n/)) {
  if (raw.trim() === "") {
   flush();
   continue;
  }
  // Wrapped Description continuation line.
  if ((raw[0] === " " || raw[0] === "\t") && cur) {
   cur.desc.push(raw.replace(/^\s+/, ""));
   continue;
  }
  const idx = raw.indexOf(":");
  if (idx < 0) continue;
  const k = raw.slice(0, idx).trim();
  const v = raw.slice(idx + 1).trim();
  if (k === "Package") {
   cur = { name: v, version: "", arch: "", section: "", filename: "", desc: [] };
   continue;
  }
  if (!cur) continue;
  switch (k) {
   case "Version":
    cur.version = v;
    break;
   case "Architecture":
    cur.arch = v;
    break;
   case "Section":
    cur.section = v;
    break;
   case "Filename":
    cur.filename = v;
    break;
   case "Source":
    cur.source = v.split(/\s+/)[0];
    break;
   case "Description":
    cur.desc.push(v);
    break;
  }
 }
 flush();
 return entries;
}

/**
 * Parse a Debian-style changelog into ordered entries (newest first).
 * Header: `pkg (version) codename; urgency=medium`
 * Footer: ` -- maintainer  RFC2822 date`
 */
export function parseChangelog(text: string, pkg: string): ChangelogEntry[] {
 const headerRe = new RegExp(
  `^${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\(([^)]+)\\)\\s+([^;]+);\\s*urgency=(.+)$`,
 );
 const footerRe = /^\s*--\s+(.+?)\s+(\w{3}, \d{1,2} \w{3} \d{4} [\d:]+ [+-]\d{4})$/;
 const lines = text.split(/\r?\n/);
 const entries: ChangelogEntry[] = [];
 let cur: {
  version: string;
  codename: string;
  urgency: string;
  maintainer?: string;
  date?: string;
  changes: string[];
 } | null = null;

 const flush = () => {
  if (!cur) return;
  entries.push({
   version: cur.version,
   codename: cur.codename,
   urgency: cur.urgency,
   ...(cur.maintainer ? { maintainer: cur.maintainer } : {}),
   ...(cur.date ? { date: cur.date } : {}),
   changes: cur.changes,
  });
  cur = null;
 };

 for (const line of lines) {
  const h = line.match(headerRe);
  if (h) {
   flush();
   cur = { version: h[1].trim(), codename: h[2].trim(), urgency: h[3].trim(), changes: [] };
   continue;
  }
  if (!cur) continue;
  const f = line.match(footerRe);
  if (f) {
   cur.maintainer = f[1].trim();
   cur.date = f[2];
   continue;
  }
  const t = line.trim();
  if (t) cur.changes.push(t);
 }
 flush();
 return entries;
}

/**
 * Changepath grouping used by Proxmox's changelog CDN:
 * "lib*" -> `lib<first-letter-after-lib>/`, otherwise `<first-letter>/`.
 */
export function letterDir(pkg: string): string {
 return pkg.startsWith("lib") ? `lib${pkg[3] ?? ""}` : (pkg[0] ?? "a");
}

/** Parse an nginx binary-index listing into { decoded .deb basename -> publish time (ms) }.
 * hrefs URL-encode "+" as "%2B", so decode before keying. */
export function binaryListingDates(html: string): Map<string, number> {
 const dates = new Map<string, number>();
 const re = /<a href="([^"]+\.deb)">[^<]+<\/a>\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})/;
 for (const line of html.split(/\r?\n/)) {
  const m = line.match(re);
  if (!m) continue;
  const name = decodeURIComponent(m[1]);
  const ms = Date.UTC(Number(m[4]), MONTHS[m[3]], Number(m[2]), Number(m[5]), Number(m[6]));
  dates.set(name, ms);
 }
 return dates;
}