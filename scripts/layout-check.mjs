/** Real App + mock IPC layout regression checks. Run after `pnpm dev`.
 * Screenshots are saved under out/layout-check for visual review.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.QAQH_LAYOUT_URL ?? "http://127.0.0.1:5173/settings-check.html";
const port = Number(process.env.QAQH_LAYOUT_CDP_PORT ?? "9335");
const output = "out/layout-check";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-layout-"))}`,
  "--no-first-run", "--disable-extensions", "--disable-sync", "about:blank",
], { stdio: "ignore" });
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json()))
        .find((page) => page.type === "page");
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* Browser is starting. */ }
    await delay(200);
  }
  assert.ok(target?.webSocketDebuggerUrl, "Headless Edge must start");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(`Fixture did not become ready: ${expression}`);
  };
  const geometry = () => evaluate(`(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const back = document.querySelector('.titlebar-back');
    const b = back?.getBoundingClientRect();
    return { top: rect('#top'), nav: rect('.global-nav'), workspace: rect('.workspace'),
      main: rect('#main'), tools: rect('.tools-page'), settings: rect('.settings-page'),
      body: rect('.settings-body'), foot: rect('.settings-foot'),
      backVisible: b ? back.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) : null,
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
  })()`);
  const capture = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${name}.png`), Buffer.from(data, "base64"));
  };
  await send("Page.enable");
  // App reads this at module evaluation. The fixture installs its full mock before rendering.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__TAURI_INTERNALS__ = {}; document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('tauri'));" });
  for (const [width, height] of [[1566, 790], [800, 600], [480, 640]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base });
    await waitFor("Boolean(document.querySelector('#app.tauri-shell .messages-empty')) && document.fonts.status === 'loaded'");
    let g = await geometry();
    assert.equal(g.top, null, "Native messages view should not reserve a visible titlebar");
    assert.equal(g.workspace.top, 0, "Messages must use all available native height");
    assert.ok(g.workspace.height > height - 70, "Messages must fill the shell");

    // Render actual Markdown inside a paint-contained turn in the actual message scroller.
    await evaluate(`(async () => {
      const { render } = await import('/node_modules/.vite/deps/@solidjs_web.js');
      const { Markdown } = await import('/src/markdown/Markdown.tsx');
      const messages = document.querySelector('#messages');
      messages.classList.remove('messages-empty');
      messages.replaceChildren();
      const turn = document.createElement('section');
      turn.className = 'turn';
      messages.append(turn);
      render(() => Markdown({ text: () => '结论依据两点：\\n\\n1. **第一条序号应该完整显示。** 这是一段足够长的内容，用来验证窄屏下换行后的文字仍然与正文对齐。\\n2. 第二条序号应该完整显示。\\n\\n多位数列表：\\n\\n99. 两位数序号\\n100. 三位数序号\\n\\n- 无序列表\\n  1. 嵌套序号', streaming: false }), turn);
      await document.fonts.ready;
    })()`);
    const markers = await evaluate(`(() => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      return Array.from(document.querySelectorAll('.md-host ol')).map((ol) => {
        const li = ol.lastElementChild;
        const style = getComputedStyle(li);
        context.font = style.font;
        const lastNumber = Number(ol.getAttribute('start') ?? 1) + ol.children.length - 1;
        return { lastNumber, padding: parseFloat(getComputedStyle(ol).paddingLeft), markerWidth: context.measureText(lastNumber + '. ').width };
      });
    })()`);
    assert.ok(markers.length >= 2, "Exercise top-level and nested ordered lists");
    assert.ok(markers.some((marker) => marker.lastNumber === 100), "Exercise actual three-digit markers");
    for (const marker of markers) assert.ok(marker.padding + 0.1 >= marker.markerWidth, `Decimal marker must fit inside the turn: ${JSON.stringify(marker)}`);
    await capture(`messages-${width}`);

    await evaluate("document.querySelectorAll('.global-nav-item')[1].click()");
    await waitFor("Boolean(document.querySelector('.tools-page'))");
    g = await geometry();
    assert.ok(g.workspace.top >= g.top.bottom, "Tools must start below the titlebar");
    assert.ok(g.workspace.bottom <= height + 1, "Tools must stay inside the window");
    assert.ok(g.main.height >= g.workspace.height - 60, "Tools content must fill the remaining height");
    assert.ok(g.tools.height > 200, "Tools must not collapse into the 56px tabs row");
    assert.equal(g.backVisible, true, "Global back button must remain unobstructed");
    assert.ok(g.scrollWidth <= width, "Shell must not overflow horizontally");
    await capture(`tools-${width}`);

    await evaluate("document.querySelectorAll('.global-nav-item')[2].click()");
    await waitFor("Boolean(document.querySelector('.settings-section'))");
    g = await geometry();
    assert.ok(g.workspace.top >= g.top.bottom, "Settings must start below the titlebar");
    assert.ok(g.body.height > 200, "Settings form must have a usable scroll area");
    assert.ok(g.foot.bottom <= g.workspace.bottom + 1, "Settings footer must stay inside its workspace");
    assert.equal(g.backVisible, true, "Settings back button must remain unobstructed");
    await capture(`settings-${width}`);
    await evaluate("document.querySelector('.titlebar-back').click()");
    await waitFor("Boolean(document.querySelector('.workspace-messages'))");
    assert.equal((await geometry()).workspace.top, 0, "Returning to messages must restore the full-height native layout");
    console.log(`PASS native shell ${width}x${height}: messages, list markers, tools, settings, back navigation`);
  }
} finally {
  socket?.close();
  child.kill();
}
