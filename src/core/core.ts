import {
 parseRelease,
 parsePackages,
 parseChangelog,
 letterDir,
 binaryListingDates,
 inflateIfGzip,
} from "./parse";
import type { PackageEntry, PackageList, ReleaseFields } from "../shared/types";
import { PRODUCTS, CACHE_SECONDS, type Product } from "../shared/config";
import { compareVersions } from "../shared/compare";
import { escapeRegex } from "../shared/regex";

/** True when `value` is a non-empty string fully matching `re`.
 * Used to whitelist user-supplied path segments before interpolating into upstream URLs —
 * forbidding "/", "\", "%", "." runs and control chars kills path traversal outright
 * (including the "%2F"-re-encoded-slash trick, since "%" is rejected). */
function validChars(re: RegExp, value: unknown): boolean {
 return typeof value === "string" && value.length > 0 && re.test(value);
}

// Distro codenames / packages / versions are constrained to Debian-safe charsets.
const SUITE_RE = /^[a-z0-9-]{1,32}$/;
const PKG_RE = /^[a-z0-9][a-z0-9+._~-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z.+~:-]{1,64}$/;

/** TTL cache abstraction; implemented per platform (Workers Cache API, in-memory). */
export interface CacheStore {
 get(url: string): Promise<CacheEntry | null>;
 put(url: string, entry: CacheEntry): Promise<void>;
}

export interface CacheEntry {
 body: string;
 fetchedAt: number;
}

/** Cache backed by the Workers Cache API (globalThis.caches in the Worker runtime). */
export class WorkersCache implements CacheStore {
 constructor(
  private readonly cache: {
   match(req: Request): Promise<Response | undefined>;
   put(req: Request, res: Response): Promise<void>;
  },
 ) { }

 async get(url: string): Promise<CacheEntry | null> {
  const resp = await this.cache.match(new Request(url));
  if (!resp) return null;
  const fetchedAt = Number(resp.headers.get("x-pve-fetched-at") ?? 0);
  return { body: await resp.text(), fetchedAt };
 }

 async put(url: string, entry: CacheEntry): Promise<void> {
  await this.cache.put(
   new Request(url),
   new Response(entry.body, { headers: { "x-pve-fetched-at": String(entry.fetchedAt) } }),
  );
 }
}

/** In-process TTL cache for platforms without the Workers Cache API (Node server).
 * Bounded to `max` entries with FIFO eviction so unauthenticated clients can't grow
 * memory without limit by requesting many distinct URLs. */
export class MemoryCache implements CacheStore {
 private readonly store = new Map<string, CacheEntry>();

 constructor(private readonly max = 1000) { }

 async get(url: string): Promise<CacheEntry | null> {
  return this.store.get(url) ?? null;
 }

 async put(url: string, entry: CacheEntry): Promise<void> {
  this.store.delete(url); // refresh insertion order
  this.store.set(url, entry);
  while (this.store.size > this.max) {
   const oldest = this.store.keys().next().value;
   if (oldest === undefined) break;
   this.store.delete(oldest);
  }
 }
}

function json(data: unknown, cacheControl: string, status = 200): Response {
 return new Response(JSON.stringify(data), {
  status,
  headers: {
   "Content-Type": "application/json; charset=utf-8",
   "Cache-Control": cacheControl,
  },
 });
}

async function fetchText(cache: CacheStore, url: string, ttlSeconds: number, gzip = false): Promise<string> {
 const hit = await cache.get(url);
 if (hit && Date.now() - hit.fetchedAt < ttlSeconds * 1000) return hit.body;
 const response = await fetch(url);
 if (!response.ok) {
  throw new Error(`upstream ${response.status} for ${url}`);
 }
 const body = gzip
  ? await inflateIfGzip(new Uint8Array(await response.arrayBuffer()))
  : await response.text();
 await cache.put(url, { body, fetchedAt: Date.now() });
 return body;
}

/** Release metadata for a product+suite; cached per URL. */
async function releaseInfo(cache: CacheStore, product: Product, suite: string): Promise<ReleaseFields> {
 const text = await fetchText(cache, `${product.repo}/dists/${suite}/Release`, CACHE_SECONDS.release);
 const info = parseRelease(text);
 if (!info.codename || info.components.length === 0) {
  throw new Error(`no usable Release metadata for "${product.id}" suite "${suite}"`);
 }
 return info;
}

/** Discover available distros from the repo's dists/ directory listing. */
async function discoverDistros(cache: CacheStore, repo: string): Promise<string[]> {
 const html = await fetchText(cache, `${repo}/dists/`, CACHE_SECONDS.listing);
 const distros: string[] = [];
 const re = /<a href="([A-Za-z0-9._-]+)\/">/g;
 for (const m of html.matchAll(re)) {
  if (m[1] !== "..") distros.push(m[1]);
 }
 return distros;
}

function packagesUrl(repo: string, suite: string, component: string, arch: string): string {
 return `${repo}/dists/${suite}/${component}/binary-${arch}/Packages.gz`;
}

/** Standard nginx directory listing of the published .debs for one arch. */
function binaryDirUrl(repo: string, suite: string, component: string, arch: string): string {
 return `${repo}/dists/${suite}/${component}/binary-${arch}/`;
}

/** Changelog CDN base URL for a Release's `Changelogs:` template
 * (everything before the `@CHANGEPATH@` placeholder). */
function changelogBaseUrl(template: string): string {
 const idx = template.indexOf("@CHANGEPATH@");
 return idx >= 0 ? template.slice(0, idx) : template;
}

/** CDN directory of all changelog files for one package. */
function changelogDirUrl(template: string, component: string, pkg: string): string {
 return `${changelogBaseUrl(template)}${component}/${letterDir(pkg)}/${pkg}/`;
}

function changelogFileUrl(template: string, component: string, pkg: string, version: string): string {
 return `${changelogBaseUrl(template)}${component}/${letterDir(pkg)}/${pkg}/${pkg}_${version}.changelog`;
}

/** Highest-version changelog file present on the CDN for a package. */
async function newestChangelogVersion(
 cache: CacheStore,
 template: string,
 component: string,
 pkg: string,
): Promise<string> {
 const listing = await fetchText(cache, changelogDirUrl(template, component, pkg), CACHE_SECONDS.listing);
 const re = new RegExp(`${escapeRegex(pkg)}_([^"<]+)\\.changelog`, "g");
 let best: string | null = null;
 for (const m of listing.matchAll(re)) {
  const version = m[1];
  if (best === null || compareVersions(version, best) > 0) best = version;
 }
 if (best === null) throw new Error(`no changelog files for package "${pkg}"`);
 return best;
}

async function handleRelease(cache: CacheStore, url: URL, product: Product, distros: string[]): Promise<Response> {
 const suite = url.searchParams.get("suite") as string;
 const info = await releaseInfo(cache, product, suite);
 return json({ product: product.id, distros, ...info }, `public, max-age=${CACHE_SECONDS.release}`);
}

async function handlePackages(cache: CacheStore, url: URL, product: Product): Promise<Response> {
 const suite = url.searchParams.get("suite") as string;
 const component = url.searchParams.get("component");
 const arch = url.searchParams.get("arch");
 if (!component || !arch) return json({ error: "component and arch are required" }, "no-store", 400);
 const info = await releaseInfo(cache, product, suite);
 if (!info.components.includes(component)) return json({ error: `unknown component "${component}"` }, "no-store", 400);
 if (!info.architectures.includes(arch)) return json({ error: `unknown architecture "${arch}"` }, "no-store", 400);

 const text = await fetchText(cache, packagesUrl(product.repo, info.codename, component, arch), CACHE_SECONDS.packages, true);
 // Return every version row; the client collapses to latest per package (squash).
 const packages = parsePackages(text);

 // Attach each package's publish time from the binary dir listing (one request per arch).
 const released = new Map<string, number>();
 try {
  const listing = await fetchText(cache, binaryDirUrl(product.repo, info.codename, component, arch), CACHE_SECONDS.listing);
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

async function handleChangelog(cache: CacheStore, url: URL, product: Product): Promise<Response> {
 const suite = url.searchParams.get("suite") as string;
 const component = url.searchParams.get("component");
 const pkg = url.searchParams.get("package");
 const source = url.searchParams.get("source");
 if (!component || !pkg) return json({ error: "component and package are required" }, "no-store", 400);
 if (!validChars(PKG_RE, pkg)) return json({ error: "invalid package name" }, "no-store", 400);
 if (source !== null && !validChars(PKG_RE, source)) return json({ error: "invalid source name" }, "no-store", 400);
 const info = await releaseInfo(cache, product, suite);
 if (!info.components.includes(component)) return json({ error: `unknown component "${component}"` }, "no-store", 400);
 const template = info.changelogsTemplate;

 const requested = url.searchParams.get("version") ?? "";
 if (requested && !validChars(VERSION_RE, requested)) return json({ error: "invalid version" }, "no-store", 400);
 // Changelogs are hosted per source package; try the binary name first, then its Source.
 const names = source && source !== pkg ? [pkg, source] : [pkg];

 for (const name of names) {
  try {
   let version = requested;
   let text: string;
   try {
    text = await fetchText(cache, changelogFileUrl(template, component, name, version), CACHE_SECONDS.changelog);
   } catch {
    // Version drift / no file for this exact version: use the newest available.
    version = await newestChangelogVersion(cache, template, component, name);
    text = await fetchText(cache, changelogFileUrl(template, component, name, version), CACHE_SECONDS.changelog);
   }
   return json(
    { product: product.id, suite: info.codename, component, package: pkg, version, entries: parseChangelog(text, name) },
    `public, max-age=${CACHE_SECONDS.changelog}`,
   );
  } catch {
   // No changelog under this name; try the next candidate.
  }
 }

 return json({ error: "No changelog available for this package." }, "no-store", 404);
}

/** Handle an `/api/*` request. Returns null for non-API paths so the caller can
 * serve static assets instead. */
export async function apiFetch(cache: CacheStore, request: Request): Promise<Response | null> {
 const url = new URL(request.url);
 if (!url.pathname.startsWith("/api/")) return null;

 if (request.method !== "GET") {
  return json({ error: "method not allowed" }, "no-store", 405);
 }

 // Liveness probe: no upstream/discovery dependency, so it never flaps.
 if (url.pathname === "/api/health") {
  return json({ status: "ok" }, "no-store");
 }

 const productId = url.searchParams.get("product") ?? PRODUCTS[0].id;
 const product = PRODUCTS.find((p) => p.id === productId);
 if (!product) return json({ error: `unknown product "${productId}"` }, "no-store", 400);
 url.searchParams.set("product", product.id);

 try {
  // Resolve + whitelist the suite against the repo's actual distros (cached),
  // which both blocks path traversal and bounds the set of upstream fetches.
  const distros = await discoverDistros(cache, product.repo);
  const requested = url.searchParams.get("suite");
  const suite = requested ?? product.default ?? distros[0] ?? "";
  if (!validChars(SUITE_RE, suite) || !distros.includes(suite)) {
   return json({ error: "unknown or invalid suite" }, "no-store", 400);
  }
  url.searchParams.set("suite", suite);

  if (url.pathname === "/api/release") return await handleRelease(cache, url, product, distros);
  if (url.pathname === "/api/packages") return await handlePackages(cache, url, product);
  if (url.pathname === "/api/changelog") return await handleChangelog(cache, url, product);
  return json({ error: "not found" }, "no-store", 404);
 } catch (e) {
  return json({ error: (e as Error).message || "internal error" }, "no-store", 502);
 }
}