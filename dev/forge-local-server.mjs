import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// This file lives in dev/, but it serves the app one level up (the actual
// Firebase Hosting root), so root points at the parent directory.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const candidatePorts = [8765, 8766, 8767, 8768, 8769];
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function send(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function requestHandler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method Not Allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  } catch {
    send(response, 400, "Bad Request");
    return;
  }

  if (pathname === "/") pathname = "/index.html";
  const requestedPath = path.resolve(root, `.${pathname}`);
  const isInsideRoot = requestedPath === root || requestedPath.startsWith(`${root}${path.sep}`);
  if (!isInsideRoot) {
    send(response, 403, "Forbidden");
    return;
  }

  fs.stat(requestedPath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      send(response, statError?.code === "ENOENT" ? 404 : 500, "File not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Type": contentTypes[path.extname(requestedPath).toLowerCase()] || "application/octet-stream",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = fs.createReadStream(requestedPath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
}

function openDefaultBrowser(url) {
  const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  opener.unref();
}

const server = http.createServer(requestHandler);
let portIndex = 0;

function listenOnNextPort() {
  if (portIndex >= candidatePorts.length) {
    console.error("Forge could not start because local ports 8765-8769 are already in use.");
    process.exitCode = 1;
    return;
  }

  const port = candidatePorts[portIndex++];
  const onError = (error) => {
    if (error.code === "EADDRINUSE") {
      listenOnNextPort();
      return;
    }
    console.error(`Forge local server error: ${error.message}`);
    process.exitCode = 1;
  };

  server.once("error", onError);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", onError);
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Forge is running at ${url}`);
    console.log("Close this window to stop the local server.");
    if (process.env.FORGE_NO_BROWSER !== "1") openDefaultBrowser(url);
  });
}

listenOnNextPort();
