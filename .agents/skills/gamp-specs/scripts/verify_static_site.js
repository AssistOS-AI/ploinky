#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

function parseArgs(argv) {
  const result = {
    docsDir: null,
    paths: [],
    expects: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--path") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("Missing value after --path");
      }
      result.paths.push(argv[index]);
      continue;
    }
    if (arg === "--expect") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("Missing value after --expect");
      }
      result.expects.push(argv[index]);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (result.docsDir) {
      throw new Error(`Unexpected extra positional argument: ${arg}`);
    }
    result.docsDir = arg;
  }

  if (!result.docsDir) {
    throw new Error("Usage: verify_static_site.js <docs-dir> [--path PATH] [--expect PATH=TEXT]");
  }

  return result;
}

function normalizePath(value) {
  return value.startsWith("/") ? value : `/${value}`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status < 500) {
        return;
      }
      lastError = new Error(`Unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Static server did not become ready on port ${port}: ${lastError?.message || "unknown error"}`);
}

async function request(port, requestPath) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`);
  const body = await response.text();
  return {
    status: response.status,
    body,
  };
}

function buildExpectations(items) {
  const expectations = new Map();
  for (const item of items) {
    const separatorIndex = item.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`Invalid --expect value: ${item}. Expected PATH=TEXT.`);
    }
    const rawPath = item.slice(0, separatorIndex);
    const text = item.slice(separatorIndex + 1);
    const requestPath = normalizePath(rawPath);
    if (!expectations.has(requestPath)) {
      expectations.set(requestPath, []);
    }
    expectations.get(requestPath).push(text);
  }
  return expectations;
}

async function stopServer(child) {
  if (!child || !child.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    child.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isPathInside(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function createStaticServer(rootDir) {
  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname.endsWith("/")) {
      pathname += "index.html";
    }

    const normalizedPath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const targetPath = path.resolve(rootDir, `.${normalizedPath}`);

    if (!isPathInside(rootDir, targetPath)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    let filePath = targetPath;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
    } catch (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".css": "text/css",
      ".gif": "image/gif",
      ".html": "text/html",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".js": "text/javascript",
      ".json": "application/json",
      ".md": "text/markdown",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".txt": "text/plain",
      ".webp": "image/webp",
    };
    const contentType = mimeTypes[extension] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": `${contentType}${contentType.startsWith("text/") ? "; charset=utf-8" : ""}` });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docsDir = path.resolve(args.docsDir);

  if (!fs.existsSync(docsDir) || !fs.statSync(docsDir).isDirectory()) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }

  const requestPaths = (args.paths.length > 0 ? args.paths : ["/", "/styles.css", "/specsLoader.html"])
    .map(normalizePath);
  const expectations = buildExpectations(args.expects);

  const port = await findFreePort();
  const server = createStaticServer(docsDir);

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    await waitForServer(port);

    let failed = false;
    for (const requestPath of requestPaths) {
      const { status, body } = await request(port, requestPath);
      if (status !== 200) {
        console.error(`FAIL ${requestPath}: expected HTTP 200, got ${status}`);
        failed = true;
        continue;
      }
      const pathExpectations = expectations.get(requestPath) || [];
      for (const needle of pathExpectations) {
        if (!body.includes(needle)) {
          console.error(`FAIL ${requestPath}: response body does not contain expected text ${JSON.stringify(needle)}`);
          failed = true;
        }
      }
      console.log(`OK   ${requestPath}`);
    }

    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
