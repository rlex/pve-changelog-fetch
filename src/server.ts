import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFetch, MemoryCache } from "./core/core";

// Bundled to dist-server/server.mjs, which sits next to ../dist.
const DIST = new URL("../dist/", import.meta.url);
const DIST_ROOT = fileURLToPath(DIST);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const cache = new MemoryCache();

async function respondNode(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(res: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = new URL(`.${pathname}`, DIST);
  if (!fileURLToPath(target).startsWith(DIST_ROOT)) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(pathname)] ?? "application/octet-stream",
      "cache-control": "public, max-age=300",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const port = Number(process.env.PORT ?? 8080);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const request = new Request(url, { method: req.method ?? "GET" });
    void apiFetch(cache, request)
      .then((response) => (response ? respondNode(res, response) : serveStatic(res, url)))
      .catch((e) => {
        console.error("api error", e);
        res.writeHead(502).end("internal error");
      });
    return;
  }
  void serveStatic(res, url).catch(() => res.writeHead(500).end("internal error"));
}).listen(port, () => console.log(`pve-changelog-web serving :${port} (dist ${DIST_ROOT})`));