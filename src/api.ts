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

export function getRelease(suite: string): Promise<ReleaseInfo> {
  return get<ReleaseInfo>(`/release?suite=${encodeURIComponent(suite)}`);
}

export function getPackages(suite: string, component: string, arch: string): Promise<PackageList> {
  return get<PackageList>(
    `/packages?suite=${encodeURIComponent(suite)}&component=${encodeURIComponent(component)}&arch=${encodeURIComponent(arch)}`,
  );
}

export function getChangelog(
  suite: string,
  component: string,
  pkg: string,
  version: string,
  source?: string,
): Promise<Changelog> {
  const src = source ? `&source=${encodeURIComponent(source)}` : "";
  return get<Changelog>(
    `/changelog?suite=${encodeURIComponent(suite)}&component=${encodeURIComponent(component)}&package=${encodeURIComponent(pkg)}&version=${encodeURIComponent(version)}${src}`,
  );
}