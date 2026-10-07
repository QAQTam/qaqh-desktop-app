/**
 * Capture repeatable visual-review screenshots from the dev-only stress fixture.
 *
 * Usage:
 *   pnpm exec vite --host 127.0.0.1
 *   pnpm exec node scripts/visual-capture.mjs
 *
 * Output defaults to artifacts/ui-visual-review. Override with QAQH_VISUAL_OUT.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_VISUAL_CDP_PORT ?? "9334");
const BASE = process.env.QAQH_VISUAL_URL ?? "http://127.0.0.1:5173/stress.html";
const OUT = resolve(process.env.QAQH_VISUAL_OUT ?? "artifacts/ui-visual-review");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const child = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-visual-"))}`,
    "--window-size=1280,900",
    "--no-first-run",
    "--disable-extensions",
    "--disable-sync",
    "--no-default-browser-check",
    `${BASE}?view=settings&theme=light&material=solid`,
  ],
  { stdio: "ignore" },
);

const cdp = await (async () => {
  let target;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
      target = pages.find((page) => page.type === "page" && page.url.startsWith(BASE));
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* Edge is still starting. */
    }
    await delay(250);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`CDP page not found for ${BASE}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return { socket, send, evaluate };
})();

async function waitForFixture(view) {
  const selector = view === "settings" ? ".settings-modal .settings-section" : view === "tools" ? ".tools-page" : "#approval-slot .card";
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const ready = await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})) && document.fonts.status === "loaded"`);
    if (ready) {
      await delay(250);
      return;
    }
    await delay(150);
  }
  throw new Error(`Visual fixture did not become ready: ${view}`);
}

async function capture(name, { view, theme, material, width, height, section } ) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const url = `${BASE}?view=${view}&theme=${theme}&material=${material}`;
  await cdp.send("Page.navigate", { url });
  await waitForFixture(view);
  if (section) {
    const navIndex = section === "section-pairing" ? 6 : 7;
    await cdp.evaluate(`document.querySelectorAll('.settings-nav-item')[${navIndex}]?.click()`);
    await delay(300);
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log(`${path} (${width}x${height})`);
}

try {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const scenarios = [
    ["settings-light-solid-desktop", { view: "settings", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["settings-dark-glass-narrow", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820 }],
    ["settings-dark-glass-narrow-pairing", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820, section: "section-pairing" }],
    ["tools-light-solid-desktop", { view: "tools", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["tools-dark-solid-narrow", { view: "tools", theme: "dark", material: "solid", width: 480, height: 820 }],
    ["approval-light-solid-desktop", { view: "approval", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["approval-light-glass-desktop", { view: "approval", theme: "light", material: "glass", width: 1280, height: 900 }],
    ["approval-dark-glass-narrow", { view: "approval", theme: "dark", material: "glass", width: 480, height: 820 }],
    ["approval-dark-solid-narrow", { view: "approval", theme: "dark", material: "solid", width: 480, height: 820 }],
  ];
  for (const [name, options] of scenarios) await capture(name, options);
} finally {
  cdp.socket.close();
  child.kill();
}
