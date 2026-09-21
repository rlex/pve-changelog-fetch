import { parseRelease, parsePackages, parseChangelog, letterDir, binaryListingDates } from "./parse";
import type { PackageEntry, PackageList, ReleaseFields } from "../src/shared/types";
import { PRODUCTS, type Product } from "../src/shared/config";
import { compareVersions } from "../src/shared/compare";

interface Env {
 ASSETS: Fetcher;
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

/** Release metadata for a product+suite; cached per URL. */
async function releaseInfo(product: Product, suite: string): Promise<ReleaseFields> {
 const text = await fetchText(`${product.repo}/dists/${suite}/Release`, CACHE_SECONDS.release);
 const info = parseRelease(text);
 if (!info.codename || info.components.length === 0) {
  throw new Error(`no usable Release metadata for "${product.id}" suite "${suite}"`);
 }
 return info;
}

/** Discover available distros from the repo's dists/ directory listing. */
async function discoverDistros(repo: string): Promise<string[]> {
 const html = await fetchText(`${repo}/dists/`, CACHE_SECONDS.listing);
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
 template: string,
 component: string,
 pkg: string,
): Promise<string> {
 const listing = await fetchText(changelogDirUrl(template, component, pkg), CACHE_SECONDS.listing);
 const re = new RegExp(`${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_([^"<]+)\\.changelog`, "g");
 let best: string | null = null;
 for (const m of listing.matchAll(re)) {
  const version = m[1];
  if (best === null || compareVersions(version, best) > 0) best = version;
 }
 if (best === null) throw new Error(`no changelog files for package "${pkg}"`);
 return best;
}

async function handleRelease(url: URL, product: Product): Promise<Response> {
 const suite = url.searchParams.get("suite") as string;
 const [distros, info] = await Promise.all([discoverDistros(product.repo), releaseInfo(product, suite)]);
 return json({ product: product.id, distros, ...info }, `public, max-age=${CACHE_SECONDS.release}`);
}

async function handlePackages(url: URL, product: Product): Promise<Response> {
 const suite = url.searchParams.get("suite") as string;
 const component = url.searchParams.get("component");
 const arch = url.searchParams.get("arch");
 if (!component || !arch) return json({ error: "component and arch are required" }, "no-store", 400);
 const info = await releaseInfo(product, suite);
 if (!info.components.includes(component)) return json({ error: `unknown component "${component}"` }, "no-store", 400);
 if (!info.architectures.includes(arch)) return json({ error: `unknown architecture "${arch}"` }, "no-store", 400);

 const text = await fetchText(packagesUrl(product.repo, info.codename, component, arch), CACHE_SECONDS.packages, true);
 // Return every version row; the client collapses to latest per package (squash).
 const packages = parsePackages(text);

 // Attach each package's publish time from the binary dir listing (one request per arch).
 const released = new Map<string, number>();
 try {
  const listing = await fetchText(binaryDirUrl(product.repo, info.codename, component, arch), CACHE_SECONDS.listing);
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

async function handleChangelog(url: URL, product: Product): Promise<Response> {
 const suite = url.searchParams.get("suite") as string;
 const component = url.searchParams.get("component");
 const pkg = url.searchParams.get("package");
 const source = url.searchParams.get("source");
 if (!component || !pkg) return json({ error: "component and package are required" }, "no-store", 400);
 const info = await releaseInfo(product, suite);
 if (!info.components.includes(component)) return json({ error: `unknown component "${component}"` }, "no-store", 400);
 const template = info.changelogsTemplate;

 const requested = url.searchParams.get("version") ?? "";
 // Changelogs are hosted per source package; try the binary name first, then its Source.
 const names = source && source !== pkg ? [pkg, source] : [pkg];

 for (const name of names) {
  try {
   let version = requested;
   let text: string;
   try {
    text = await fetchText(changelogFileUrl(template, component, name, version), CACHE_SECONDS.changelog);
   } catch {
    // Version drift / no file for this exact version: use the newest available.
    version = await newestChangelogVersion(template, component, name);
    text = await fetchText(changelogFileUrl(template, component, name, version), CACHE_SECONDS.changelog);
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

export default {
 async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
   return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET") {
   return json({ error: "method not allowed" }, "no-store", 405);
  }

  const productId = url.searchParams.get("product") ?? PRODUCTS[0].id;
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) return json({ error: `unknown product "${productId}"` }, "no-store", 400);
  url.searchParams.set("product", product.id);
  const requested = url.searchParams.get("suite");
  if (!requested) {
   const distros = await discoverDistros(product.repo);
   url.searchParams.set("suite", product.default ?? distros[0] ?? "");
  }

  try {
   if (url.pathname === "/api/release") return await handleRelease(url, product);
   if (url.pathname === "/api/packages") return await handlePackages(url, product);
   if (url.pathname === "/api/changelog") return await handleChangelog(url, product);
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