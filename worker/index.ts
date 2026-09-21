import { parseRelease, parsePackages, parseChangelog, letterDir, compareVersions } from "./parse";
import type { PackageEntry, PackageList, ReleaseInfo } from "../src/shared/types";

const REPO_BASE = "http://download.proxmox.com/debian/pve";
const CHANGELOG_BASE = "https://metadata.cdn.proxmox.com/download/changelogs/pve";

interface Env {
 ASSETS: Fetcher;
 PVE_SUITE: string;
}

const CACHE_SECONDS = {
 release: 300,
 packages: 900,
 changelog: 3600,
 listing: 900,
} as const;

const corsHeaders = {
 "Access-Control-Allow-Origin": "*",
 "Access-Control-Allow-Methods": "GET, OPTIONS",
 "Access-Control-Allow-Headers": "Content-Type",
 "Access-Control-Max-Age": "86400",
};

function json(data: unknown, cacheControl: string, status = 200): Response {
 return new Response(JSON.stringify(data), {
  status,
  headers: {
   "Content-Type": "application/json; charset=utf-8",
   "Cache-Control": cacheControl,
   ...corsHeaders,
  },
 });
}

/** Fetch a URL's body text with a TTL'd in-memory Cache API entry.
 * When `gzip` is true the upstream body is a .gz archive and is decompressed
 * once before being cached (so we cache the plain text). */
async function fetchText(url: string, ttlSeconds: number, gzip = false): Promise<string> {
 const cache = caches.default;
 const request = new Request(url);
 const hit = await cache.match(request);
 if (hit) {
  const fetchedAt = Number(hit.headers.get("x-pve-fetched-at") ?? 0);
  if (fetchedAt && Date.now() - fetchedAt < ttlSeconds * 1000) return await hit.text();
 }
 const response = await fetch(url);
 if (!response.ok) {
  throw new Error(`upstream ${response.status} for ${url}`);
 }
 const body = gzip
  ? await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).text()
  : await response.text();
 await cache.put(
  request,
  new Response(body, { headers: { "x-pve-fetched-at": String(Date.now()) } }),
 );
 return body;
}

/** Release for a suite; result is cached for the session. */
async function releaseInfo(suite: string): Promise<ReleaseInfo> {
 const text = await fetchText(`${REPO_BASE}/dists/${suite}/Release`, CACHE_SECONDS.release);
 const info = parseRelease(text);
 if (!info.codename || info.components.length === 0) {
  throw new Error(`no usable Release metadata for suite "${suite}"`);
 }
 return info;
}

function packagesUrl(suite: string, component: string, arch: string): string {
 return `${REPO_BASE}/dists/${suite}/${component}/binary-${arch}/Packages.gz`;
}

/** Standard nginx directory listing of the published .debs for one arch. */
function binaryDirUrl(suite: string, component: string, arch: string): string {
 return `${REPO_BASE}/dists/${suite}/${component}/binary-${arch}/`;
}

/** CDN directory of all changelog files for one package. */
function changelogDirUrl(suite: string, component: string, pkg: string): string {
 return `${CHANGELOG_BASE}/dists/${suite}/${component}/${letterDir(pkg)}/${pkg}/`;
}

function changelogFileUrl(suite: string, component: string, pkg: string, version: string): string {
 return `${CHANGELOG_BASE}/dists/${suite}/${component}/${letterDir(pkg)}/${pkg}/${pkg}_${version}.changelog`;
}

/** Highest-version changelog file present on the CDN for a package. */
async function newestChangelogVersion(
 suite: string,
 component: string,
 pkg: string,
): Promise<string> {
 const listing = await fetchText(changelogDirUrl(suite, component, pkg), CACHE_SECONDS.listing);
 const re = new RegExp(`${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_([^"<]+)\\.changelog`, "g");
 let best: string | null = null;
 for (const m of listing.matchAll(re)) {
  const version = m[1];
  if (best === null || compareVersions(version, best) > 0) best = version;
 }
 if (best === null) throw new Error(`no changelog files for package "${pkg}"`);
 return best;
}

const MONTHS: Record<string, number> = {
 Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
 Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse an nginx binary-index listing into { decoded .deb basename -> publish time (ms) }.
 * hrefs URL-encode "+" as "%2B", so decode before keying. */
function binaryListingDates(html: string): Map<string, number> {
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

async function handleRelease(url: URL): Promise<Response> {
 const suite = url.searchParams.get("suite") ?? "";
 const info = await releaseInfo(suite);
 return json(info, `public, max-age=${CACHE_SECONDS.release}`);
}

async function handlePackages(url: URL): Promise<Response> {
 const suite = url.searchParams.get("suite") ?? "";
 const component = url.searchParams.get("component");
 const arch = url.searchParams.get("arch");
 if (!component || !arch) return json({ error: "component and arch are required" }, "no-store", 400);
 const info = await releaseInfo(suite);
 if (!info.components.includes(component)) return json({ error: `unknown component "${component}"` }, "no-store", 400);
 if (!info.architectures.includes(arch)) return json({ error: `unknown architecture "${arch}"` }, "no-store", 400);

 const text = await fetchText(packagesUrl(info.codename, component, arch), CACHE_SECONDS.packages, true);
 // Return every version row; the client collapses to latest per package (squash).
 const packages = parsePackages(text);

 // Attach each package's publish time from the binary dir listing (one request per arch).
 const released = new Map<string, number>();
 try {
  const listing = await fetchText(binaryDirUrl(info.codename, component, arch), CACHE_SECONDS.listing);
  for (const [basename, ms] of binaryListingDates(listing)) released.set(basename, ms);
 } catch {
  // Listing is an enhancement; packages still load without release dates.
 }
 const withDates: PackageEntry[] = packages.map((p) => ({
  ...p,
  released: released.get(p.filename.split("/").pop() as string) ?? null,
 }));

 const result: PackageList = {
  suite: info.codename,
  component,
  arch,
  total: packages.length,
  packages: withDates,
 };
 return json(result, `public, max-age=${CACHE_SECONDS.packages}`);
}

async function handleChangelog(url: URL): Promise<Response> {
 const suite = url.searchParams.get("suite") ?? "";
 const component = url.searchParams.get("component");
 const pkg = url.searchParams.get("package");
 const source = url.searchParams.get("source");
 if (!component || !pkg) return json({ error: "component and package are required" }, "no-store", 400);
 const info = await releaseInfo(suite);
 if (!info.components.includes(component)) return json({ error: `unknown component "${component}"` }, "no-store", 400);

 const requested = url.searchParams.get("version") ?? "";
 // Changelogs are hosted per source package; try the binary name first, then its Source.
 const names = source && source !== pkg ? [pkg, source] : [pkg];

 for (const name of names) {
  try {
   let version = requested;
   let text: string;
   try {
    text = await fetchText(changelogFileUrl(info.codename, component, name, version), CACHE_SECONDS.changelog);
   } catch {
    // Version drift / no file for this exact version: use the newest available.
    version = await newestChangelogVersion(info.codename, component, name);
    text = await fetchText(changelogFileUrl(info.codename, component, name, version), CACHE_SECONDS.changelog);
   }
   return json(
    { suite: info.codename, component, package: pkg, version, entries: parseChangelog(text, name) },
    `public, max-age=${CACHE_SECONDS.changelog}`,
   );
  } catch {
   // No changelog under this name; try the next candidate.
  }
 }

 return json({ error: "No changelog available for this package." }, "no-store", 404);
}

export default {
 async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
   return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET") {
   return json({ error: "method not allowed" }, "no-store", 405);
  }

  const suite = url.searchParams.get("suite") ?? env.PVE_SUITE ?? "trixie";
  url.searchParams.set("suite", suite);

  try {
   if (url.pathname === "/api/release") return await handleRelease(url);
   if (url.pathname === "/api/packages") return await handlePackages(url);
   if (url.pathname === "/api/changelog") return await handleChangelog(url);
   if (url.pathname.startsWith("/api/")) {
    return json({ error: "not found" }, "no-store", 404);
   }
   // Static frontend (Vite build output) for everything else.
   return env.ASSETS.fetch(request);
  } catch (e) {
   return json({ error: (e as Error).message || "internal error" }, "no-store", 502);
  }
 },
};