import "./style.css";
import { ApiError, getChangelog, getPackages, getRelease } from "./api";
import type { Changelog, ChangelogEntry, PackageEntry, PackageList, ReleaseInfo } from "./shared/types";
import { PRODUCTS, CACHE_SECONDS, type Product } from "./shared/config";
import {
  debounce,
  formatReleaseDate,
  listBullets,
  matchesPackageName,
  readCache,
  sortPackages,
  squashRows,
  writeCache,
  type SortMode,
} from "./lib";

const productSelect = document.getElementById("product-select") as HTMLSelectElement;
const suiteSelect = document.getElementById("suite-select") as HTMLSelectElement;
const componentSelect = document.getElementById("component-select") as HTMLSelectElement;
const archSelect = document.getElementById("arch-select") as HTMLSelectElement;
const searchInput = document.getElementById("search") as HTMLInputElement;
const searchHelpToggle = document.getElementById("search-help-toggle") as HTMLButtonElement;
const searchHelp = document.getElementById("search-help") as HTMLElement;
const sortSelect = document.getElementById("sort-select") as HTMLSelectElement;
const squashCheckbox = document.getElementById("squash-checkbox") as HTMLInputElement;
const repoLine = document.getElementById("repo-line") as HTMLElement;
const listMeta = document.getElementById("list-meta") as HTMLElement;
const listEl = document.getElementById("pkg-list") as HTMLUListElement;
const listMsg = document.getElementById("list-msg") as HTMLElement;
const detailMsg = document.getElementById("detail-msg") as HTMLElement;
const detailArticle = document.getElementById("detail-article") as HTMLElement;

let product: Product = PRODUCTS[0];
let suite = "";
let component = "";
let arch = "";
let packages: PackageEntry[] = [];
let allRows: PackageEntry[] = [];
let selectedPkg: PackageEntry | null = null;

let sortMode: SortMode = "recent";

const packageCache = new Map<string, PackageList>();
const changelogCache = new Map<string, Changelog>();
const releaseCache = new Map<string, ReleaseInfo>();

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cacheKey(productArg: string, suiteArg: string, componentArg: string, archArg: string): string {
  return `${productArg}/${suiteArg}/${componentArg}/${archArg}`;
}

function setMsg(el: HTMLElement, text: string, show = true): void {
  el.textContent = text;
  el.hidden = !show;
}

async function fetchRelease(): Promise<void> {
  setMsg(repoLine, `Loading ${product.name}…`);
  try {
    const relKey = `${product.id}|${suite || "default"}`;
    let info = releaseCache.get(relKey)
      ?? readCache<ReleaseInfo>(localStorage, `pvc:rel:${relKey}`, CACHE_SECONDS.release);
    if (!info) {
      info = await getRelease(product.id, suite || undefined);
      releaseCache.set(relKey, info);
      writeCache(localStorage, `pvc:rel:${relKey}`, info);
    }
    suite = info.codename;
    fillSuiteSelect(info.distros);
    repoLine.textContent = `${product.name} — ${suite} (${info.suite}) — ${info.date} · arch: ${info.architectures.join(", ")}`;
    fillSelect(componentSelect, info.components, component);
    fillSelect(archSelect, info.architectures, arch);
    component = componentSelect.value;
    arch = archSelect.value;
    componentSelect.disabled = false;
    archSelect.disabled = false;
    searchInput.disabled = false;
    await loadPackages();
  } catch (e) {
    setMsg(repoLine, `Could not load "${product.name}" suite "${suite}": ${(e as Error).message}`);
    componentSelect.disabled = true;
    archSelect.disabled = true;
    searchInput.disabled = true;
    setMsg(listMsg, "Repository unavailable.");
  }
}

function fillSelect(el: HTMLSelectElement, values: string[], preferred: string): void {
  el.textContent = "";
  for (const value of values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    el.appendChild(opt);
  }
  el.value = preferred && values.includes(preferred) ? preferred : (values[0] ?? "");
}

async function loadPackages(): Promise<void> {
  selectedPkg = null;
  detailArticle.hidden = true;
  setMsg(detailMsg, "Select a package to view its changelog.");
  const key = cacheKey(product.id, suite, component, arch);
  listMsg.hidden = true;
  listEl.textContent = "";
  searchInput.value = "";

  let data = packageCache.get(key)
    ?? readCache<PackageList>(localStorage, `pvc:pkg:${key}`, CACHE_SECONDS.packages);
  if (!data) {
    setMsg(repoLine, `Loading ${component} / ${arch}…`);
    try {
      data = await getPackages(product.id, suite, component, arch);
      packageCache.set(key, data);
      writeCache(localStorage, `pvc:pkg:${key}`, data);
    } catch (e) {
      setMsg(repoLine, `Could not load packages: ${(e as Error).message}`);
      setMsg(listMsg, "Failed to load package list.");
      return;
    }
  }
  allRows = data.packages;
  applySquash();
}

/** Recompute the displayed list from all version rows per the squash toggle. */
function applySquash(): void {
  packages = squashCheckbox.checked ? squashRows(allRows) : allRows;
  const note = squashCheckbox.checked && allRows.length !== packages.length
    ? ` (${allRows.length} versions)`
    : "";
  setMsg(repoLine, `Loaded ${packages.length} packages${note} in ${component} / ${arch}.`);
  renderList();
  writeUrlState();
}

function filteredPackages(): PackageEntry[] {
  const q = searchInput.value.trim();
  const base = q ? packages.filter((p) => matchesPackageName(p.name, q)) : packages;
  return sortPackages(base, sortMode);
}

function renderList(): void {
  const shown = filteredPackages();
  const label = sortMode === "recent" ? "recently updated" : "name";
  listMeta.textContent = shown.length === packages.length
    ? `${shown.length} packages · sorted by ${label}`
    : `${shown.length} of ${packages.length} packages · sorted by ${label}`;
  listEl.textContent = "";
  for (const p of shown) {
    const li = document.createElement("li");
    li.className = "pkg-row";
    li.dataset.pkg = p.name;
    li.dataset.version = p.version;
    const selected = selectedPkg?.name === p.name;
    li.innerHTML = `
      <div class="pkg-main">
        <span class="pkg-name">${esc(p.name)}</span>
        <span class="pkg-desc">${esc(p.description)}</span>
      </div>
      <div class="pkg-side">
        <span class="pkg-section">${esc(p.section)}</span>
        <span class="pkg-version">${esc(p.version)}</span>
        ${p.released != null ? `<span class="pkg-date">${esc(formatReleaseDate(p.released))}</span>` : ""}
      </div>`;
    if (selected) li.classList.add("selected");
    listEl.appendChild(li);
  }
  if (shown.length === 0) setMsg(listMsg, "No packages match your search.");
  else listMsg.hidden = true;
}

function renderEntry(entry: ChangelogEntry): string {
  const bullets = listBullets(entry.changes);
  const meta = [entry.urgency, entry.date, entry.maintainer].filter(Boolean).join(" · ");
  return `
    <section class="entry">
      <header class="entry-head">
        <span class="entry-version">${esc(entry.version)}</span>
        <span class="entry-meta">${esc(meta)}</span>
      </header>
      <ul class="entry-changes">
        ${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}
      </ul>
    </section>`;
}

async function showChangelog(pkg: PackageEntry): Promise<void> {
  selectedPkg = pkg;
  renderList();
  const key = `${product.id}|${suite}|${component}|${pkg.name}|${pkg.version}`;
  detailMsg.hidden = false;
  setMsg(detailMsg, `Loading changelog for ${pkg.name}…`);
  detailArticle.hidden = true;

  let data = changelogCache.get(key)
    ?? readCache<Changelog>(localStorage, `pvc:chg:${key}`, CACHE_SECONDS.changelog);
  if (!data) {
    try {
      data = await getChangelog(product.id, suite, component, pkg.name, pkg.version, pkg.source);
      changelogCache.set(key, data);
      writeCache(localStorage, `pvc:chg:${key}`, data);
    } catch (e) {
      setMsg(detailMsg, e instanceof ApiError && e.status === 404
        ? "No changelog available for this package."
        : `Failed to load changelog: ${(e as Error).message}`);
      return;
    }
  }

  detailMsg.hidden = true;
  detailArticle.hidden = false;
  const head = `
    <header class="detail-head">
      <h2>${esc(data.package)}</h2>
      <p class="detail-sub">${esc(data.version)} · ${esc(data.suite)} / ${esc(data.component)} · ${data.entries.length} entries</p>
    </header>`;
  detailArticle.innerHTML = head + data.entries.map(renderEntry).join("");
}

// --- Wiring ---

function fillSuiteSelect(distros: string[]): void {
  suiteSelect.textContent = "";
  for (const d of distros) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    suiteSelect.appendChild(opt);
  }
  suiteSelect.value = suite && distros.includes(suite) ? suite : (distros[0] ?? "");
}

productSelect.textContent = "";
for (const p of PRODUCTS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.name;
  productSelect.appendChild(opt);
}
productSelect.value = product.id;

interface UrlState {
  productId?: string;
  suite?: string;
  component?: string;
  arch?: string;
  q?: string;
  sort?: SortMode;
  squash?: boolean;
}

function readUrlState(): UrlState {
  const u = new URLSearchParams(window.location.search);
  const state: UrlState = {};
  const productId = u.get("product");
  if (productId && PRODUCTS.some((p) => p.id === productId)) state.productId = productId;
  for (const key of ["suite", "component", "arch"] as const) {
    const value = u.get(key);
    if (value) state[key] = value;
  }
  const q = u.get("q");
  if (q !== null) state.q = q;
  const sort = u.get("sort");
  if (sort === "name" || sort === "recent") state.sort = sort;
  const squash = u.get("squash");
  if (squash === "0") state.squash = false;
  else if (squash === "1") state.squash = true;
  return state;
}

/** Mirror current UI state into the URL query (no history entry) for shareable links. */
function writeUrlState(): void {
  const params = new URLSearchParams();
  if (product.id !== PRODUCTS[0].id) params.set("product", product.id);
  if (suite) params.set("suite", suite);
  if (component) params.set("component", component);
  if (arch) params.set("arch", arch);
  const q = searchInput.value.trim();
  if (q) params.set("q", q);
  if (sortMode !== "recent") params.set("sort", sortMode);
  if (!squashCheckbox.checked) params.set("squash", "0");
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

// Seed initial state from the URL (deep links), before the first load.
const urlState = readUrlState();
if (urlState.productId) product = PRODUCTS.find((p) => p.id === urlState.productId) ?? product;
productSelect.value = product.id;
suite = urlState.suite ?? "";
component = urlState.component ?? "";
arch = urlState.arch ?? "";
if (urlState.sort) sortMode = urlState.sort;
sortSelect.value = sortMode;
if (urlState.squash !== undefined) squashCheckbox.checked = urlState.squash;
searchInput.value = urlState.q ?? "";

productSelect.addEventListener("change", () => {
  product = PRODUCTS.find((p) => p.id === productSelect.value) ?? PRODUCTS[0];
  suite = "";
  componentSelect.disabled = true;
  archSelect.disabled = true;
  void fetchRelease();
  writeUrlState();
});

suiteSelect.addEventListener("change", () => {
  suite = suiteSelect.value;
  void fetchRelease();
  writeUrlState();
});

componentSelect.addEventListener("change", () => {
  component = componentSelect.value;
  void loadPackages();
  writeUrlState();
});

archSelect.addEventListener("change", () => {
  arch = archSelect.value;
  void loadPackages();
  writeUrlState();
});

searchInput.addEventListener("input", debounce(() => {
  renderList();
  writeUrlState();
}, 120));

searchHelpToggle.addEventListener("click", (ev) => {
  ev.stopPropagation();
  searchHelp.hidden = !searchHelp.hidden;
});
document.addEventListener("click", () => {
  searchHelp.hidden = true;
});

sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value === "name" ? "name" : "recent";
  renderList();
  writeUrlState();
});

squashCheckbox.addEventListener("change", applySquash);

listEl.addEventListener("click", (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLLIElement>("li.pkg-row");
  if (!target) return;
  const pkg = packages.find(
    (p) => p.name === target.dataset.pkg && p.version === target.dataset.version,
  );
  if (pkg) void showChangelog(pkg);
});

void fetchRelease();