import "./style.css";
import { ApiError, getChangelog, getPackages, getRelease } from "./api";
import type { Changelog, ChangelogEntry, PackageEntry, PackageList } from "./shared/types";

// Proxmox VE is Debian-only. The Worker defaults to trixie; any valid dists/ Debian
// codename is honored via ?suite=.
const SUITES = ["trixie", "bookworm", "bullseye"];
const DEFAULT_SUITE = "trixie";

const suiteSelect = document.getElementById("suite-select") as HTMLSelectElement;
const componentSelect = document.getElementById("component-select") as HTMLSelectElement;
const archSelect = document.getElementById("arch-select") as HTMLSelectElement;
const searchInput = document.getElementById("search") as HTMLInputElement;
const sortSelect = document.getElementById("sort-select") as HTMLSelectElement;
const squashCheckbox = document.getElementById("squash-checkbox") as HTMLInputElement;
const repoLine = document.getElementById("repo-line") as HTMLElement;
const listMeta = document.getElementById("list-meta") as HTMLElement;
const listEl = document.getElementById("pkg-list") as HTMLUListElement;
const listMsg = document.getElementById("list-msg") as HTMLElement;
const detailMsg = document.getElementById("detail-msg") as HTMLElement;
const detailArticle = document.getElementById("detail-article") as HTMLElement;

let suite = DEFAULT_SUITE;
let component = "";
let arch = "";
let packages: PackageEntry[] = [];
let allRows: PackageEntry[] = [];
let selectedPkg: PackageEntry | null = null;

type SortMode = "recent" | "name";
let sortMode: SortMode = "recent";

const packageCache = new Map<string, PackageList>();
const changelogCache = new Map<string, Changelog>();

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cacheKey(suiteArg: string, componentArg: string, archArg: string): string {
  return `${suiteArg}/${componentArg}/${archArg}`;
}

function setMsg(el: HTMLElement, text: string, show = true): void {
  el.textContent = text;
  el.hidden = !show;
}

async function fetchRelease(): Promise<void> {
  setMsg(repoLine, "Loading repository…");
  try {
    const info = await getRelease(suite);
    repoLine.textContent = `${info.codename} (${info.suite}) — ${info.date} · arch: ${info.architectures.join(", ")}`;
    fillSelect(componentSelect, info.components, component);
    fillSelect(archSelect, info.architectures, arch);
    component = componentSelect.value;
    arch = archSelect.value;
    componentSelect.disabled = false;
    archSelect.disabled = false;
    searchInput.disabled = false;
    await loadPackages();
  } catch (e) {
    setMsg(repoLine, `Could not load suite "${suite}": ${(e as Error).message}`);
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
  const key = cacheKey(suite, component, arch);
  listMsg.hidden = true;
  listEl.textContent = "";
  searchInput.value = "";

  let data = packageCache.get(key);
  if (!data) {
    setMsg(repoLine, `Loading ${component} / ${arch}…`);
    try {
      data = await getPackages(suite, component, arch);
      packageCache.set(key, data);
    } catch (e) {
      setMsg(repoLine, `Could not load packages: ${(e as Error).message}`);
      setMsg(listMsg, "Failed to load package list.");
      return;
    }
  }
  allRows = data.packages;
  applySquash();
}

/** Compare Debian-ish versions; >0 if `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    v
      .split(/[.~+-]/)
      .map((part) => (/^\d+$/.test(part) ? part.padStart(12, "0") : part))
      .join("\u0000");
  return norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0;
}

/** Collapse to the highest version of each package name. */
function squashRows(rows: PackageEntry[]): PackageEntry[] {
  const best = new Map<string, PackageEntry>();
  for (const p of rows) {
    const prev = best.get(p.name);
    if (!prev || compareVersions(p.version, prev.version) > 0) best.set(p.name, p);
  }
  return [...best.values()];
}

/** Recompute the displayed list from all version rows per the squash toggle. */
function applySquash(): void {
  packages = squashCheckbox.checked ? squashRows(allRows) : allRows;
  const note = squashCheckbox.checked && allRows.length !== packages.length
    ? ` (${allRows.length} versions)`
    : "";
  setMsg(repoLine, `Loaded ${packages.length} packages${note} in ${component} / ${arch}.`);
  renderList();
}

function filteredPackages(): PackageEntry[] {
  const q = searchInput.value.trim().toLowerCase();
  const base = q
    ? packages.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    )
    : packages;
  if (sortMode === "name") return [...base].sort((a, b) => a.name.localeCompare(b.name));
  return [...base].sort((a, b) => {
    const da = a.released ?? -Infinity;
    const db = b.released ?? -Infinity;
    if (da !== db) return db - da;
    return a.name.localeCompare(b.name);
  });
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

/** Fold wrapped changelog lines back into bullet items. */
function listBullets(lines: string[]): string[] {
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

async function showChangelog(pkg: PackageEntry): Promise<void> {
  selectedPkg = pkg;
  renderList();
  const key = `${suite}|${component}|${pkg.name}|${pkg.version}`;
  detailMsg.hidden = false;
  setMsg(detailMsg, `Loading changelog for ${pkg.name}…`);
  detailArticle.hidden = true;

  let data = changelogCache.get(key);
  if (!data) {
    try {
      data = await getChangelog(suite, component, pkg.name, pkg.version, pkg.source);
      changelogCache.set(key, data);
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

suiteSelect.textContent = "";
for (const s of SUITES) {
  const opt = document.createElement("option");
  opt.value = s;
  opt.textContent = s;
  suiteSelect.appendChild(opt);
}
suiteSelect.value = DEFAULT_SUITE;

suiteSelect.addEventListener("change", () => {
  suite = suiteSelect.value;
  void fetchRelease();
});

componentSelect.addEventListener("change", () => {
  component = componentSelect.value;
  void loadPackages();
});

archSelect.addEventListener("change", () => {
  arch = archSelect.value;
  void loadPackages();
});

searchInput.addEventListener("input", renderList);

sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value === "name" ? "name" : "recent";
  renderList();
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