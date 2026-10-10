/**
 * Serve the built SPA with the template CSP and load it in headless Chrome.
 * Fails if index.html has inline script/style, or the page reports a CSP violation.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCspSub, inlineDocumentViolations, renderCsp } from "./csp-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const templatePath = join(root, "infra", "template.yaml");
const SMOKE_API_ID = "a1b2c3d4e5";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** @param {string} chromePath */
export function chromeArgs(chromePath, port, userDataDir) {
  return [
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--no-first-run",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
  ];
}

function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  const candidates = [
    fromEnv,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/local/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates;
}

async function existingChrome() {
  for (const candidate of findChrome()) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try the next path
    }
  }
  throw new Error("Chrome was not found. Set CHROME_PATH.");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} port
 */
async function waitForPage(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools did not open");
}

/**
 * @param {import("node:http").Server} server
 * @param {string} csp
 */
function listen(server, csp) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve(address.port);
    });
    server.on("error", reject);
    void csp;
  });
}

/**
 * @param {string} dist
 * @param {string} csp
 */
function startStaticServer(dist, csp) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      const file = normalize(join(dist, relative));
      if (file !== dist && !file.startsWith(dist + sep)) {
        res.writeHead(400);
        res.end();
        return;
      }
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "content-security-policy": csp,
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-robots-tag": "noindex, nofollow",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
  return server;
}

async function main() {
  const indexPath = join(distDir, "index.html");
  const html = await readFile(indexPath, "utf8");
  const inline = inlineDocumentViolations(html);
  if (inline.length > 0) {
    throw new Error(`Built index.html is not CSP-safe: ${inline.join(", ")}`);
  }
  const template = await readFile(templatePath, "utf8");
  const csp = renderCsp(extractCspSub(template), "ap-northeast-1", SMOKE_API_ID);
  const robots = await readFile(join(distDir, "robots.txt"), "utf8");
  if (!robots.includes("User-agent: *") || !robots.includes("Disallow: /")) {
    throw new Error("dist/robots.txt does not disallow all crawlers");
  }
  if (!html.includes('name="robots"') || !html.includes("noindex, nofollow")) {
    throw new Error("Built index.html is missing the robots meta tag");
  }

  const server = startStaticServer(distDir, csp);
  const port = await listen(server, csp);
  const url = `http://127.0.0.1:${port}/`;
  const chromePath = await existingChrome();
  const userDataDir = await mkdtemp(join(tmpdir(), "csp-smoke-"));
  const debugPort = await freePort();
  const chrome = spawn(chromePath, chromeArgs(chromePath, debugPort, userDataDir)[1], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let chromeErr = "";
  chrome.stderr?.on("data", (chunk) => {
    chromeErr += chunk.toString();
    if (chromeErr.length > 4000) chromeErr = chromeErr.slice(-4000);
  });

  try {
    const wsUrl = await waitForPage(debugPort);
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DevTools websocket timed out")), 10000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("DevTools websocket failed"));
      });
    });

    let nextId = 0;
    /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
    const pending = new Map();
    /** @type {string[]} */
    const exceptions = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
        else waiter?.resolve(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") {
        const text = message.params?.exceptionDetails?.text ?? "exception";
        const description = message.params?.exceptionDetails?.exception?.description ?? "";
        exceptions.push(`${text} ${description}`.trim());
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__cspViolations=[];document.addEventListener("securitypolicyviolation",(event)=>{window.__cspViolations.push(event.violatedDirective+" "+event.blockedURI+" "+event.sourceFile);});`,
    });
    await send("Page.navigate", { url });

    /** @type {{ children: number, text: string, violations: string[], title: string }} */
    let page = { children: 0, text: "", violations: [], title: "" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const evaluated = await send("Runtime.evaluate", {
        expression: `(() => ({ children: document.querySelector("#root")?.childElementCount ?? -1, text: (document.querySelector("#root")?.innerText ?? "").slice(0, 180), violations: window.__cspViolations || [], title: document.title }))()`,
        returnByValue: true,
      });
      page = evaluated.result.value;
      if (page.children > 0) break;
      await delay(250);
    }
    if (page.children < 1) {
      throw new Error(`SPA root did not render (${page.title || "no title"})`);
    }
    if (page.violations.length > 0) {
      throw new Error(`CSP violations: ${page.violations.join(" | ")}`);
    }

    /** @type {{ registered: boolean, script: string }} */
    let worker = { registered: false, script: "" };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const evaluated = await send("Runtime.evaluate", {
        expression: `navigator.serviceWorker.getRegistration().then((registration) => ({ registered: !!registration, script: registration?.active?.scriptURL || registration?.installing?.scriptURL || registration?.waiting?.scriptURL || "" }))`,
        awaitPromise: true,
        returnByValue: true,
      });
      worker = evaluated.result.value;
      if (worker.registered) break;
      await delay(250);
    }
    if (!worker.registered) {
      throw new Error("Service worker did not register");
    }
    if (exceptions.length > 0) {
      throw new Error(`Page exception: ${exceptions.join(" | ")}`);
    }
    const manifest = await send("Runtime.evaluate", {
      expression: `document.querySelector('link[rel="manifest"]')?.href || ""`,
      returnByValue: true,
    });
    if (!String(manifest.result.value).includes("manifest.webmanifest")) {
      throw new Error("manifest link is missing");
    }
    ws.close();
    console.log("CSP smoke passed");
  } catch (error) {
    if (chromeErr.trim()) console.error(chromeErr.trim().slice(-1000));
    throw error;
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("csp-smoke.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "CSP smoke failed");
    process.exit(1);
  });
}
