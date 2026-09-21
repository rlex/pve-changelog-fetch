import type { Changelog, PackageList, ReleaseInfo } from "./shared/types";

const API = "/api";

/** Error with the HTTP status the worker returned. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") detail = body.error;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, `${res.status} ${detail}`.trim());
  }
  return (await res.json()) as T;
}

export function getRelease(product: string, suite?: string): Promise<ReleaseInfo> {
  const s = suite ? `&suite=${encodeURIComponent(suite)}` : "";
  return get<ReleaseInfo>(`/release?product=${encodeURIComponent(product)}${s}`);
}

export function getPackages(
  product: string,
  suite: string,
  component: string,
  arch: string,
): Promise<PackageList> {
  return get<PackageList>(
    `/packages?product=${encodeURIComponent(product)}&suite=${encodeURIComponent(suite)}&component=${encodeURIComponent(component)}&arch=${encodeURIComponent(arch)}`,
  );
}

export function getChangelog(
  product: string,
  suite: string,
  component: string,
  pkg: string,
  version: string,
  source?: string,
): Promise<Changelog> {
  const src = source ? `&source=${encodeURIComponent(source)}` : "";
  return get<Changelog>(
    `/changelog?product=${encodeURIComponent(product)}&suite=${encodeURIComponent(suite)}&component=${encodeURIComponent(component)}&package=${encodeURIComponent(pkg)}&version=${encodeURIComponent(version)}${src}`,
  );
}