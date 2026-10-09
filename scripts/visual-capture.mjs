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
  const selector = view === "settings" ? ".settings-page .settings-section" : view === "tools" ? ".tools-page" : view === "messages" ? "#messages .turn" : "#approval-slot .card";
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

async function clickTodo() {
  const point = await cdp.evaluate(`(() => {
    const button = document.querySelector('.workspace-panel-head'), r = button.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Todo header is not pointer-accessible');
    return { x, y };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}

async function capture(name, { view, theme, material, width, height, section, closed = false, scale = 1, reduced = false, typography = false } ) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
  const url = `${BASE}?view=${view}&theme=${theme}&material=${material}`;
  await cdp.send("Page.navigate", { url });
  await waitForFixture(view);
  if (scale !== 1) await cdp.evaluate(`document.documentElement.style.zoom = ${scale}`);
  if (view === "messages") {
    if (await cdp.evaluate("Boolean(document.querySelector('.session-capsule'))")) throw new Error('Future Goal capsule must not render');
    // Local fixture only: exercise every task state without contacting the daemon.
    await cdp.evaluate(`window.__stress.store.todos[1]([
      { title: '统一布局与内容对齐', status: 'completed' },
      { title: '收敛圆角、字体与表面层级', status: 'completed' },
      { title: '检查亮暗主题与动效细节', status: 'in_progress' },
      { title: '验证窄窗口、长文本与键盘操作', status: 'pending' }
    ])`);
    await delay(300);
    if (typography) await cdp.evaluate(`(async () => {
      const { renderMarkdownHtml } = await import('/src/markdown/render.ts');
      const tick = String.fromCharCode(96);
      const source = ['# Markdown 排版基准', '正文采用 GitHub Primer 的 16px / 24px。**强调不改变字号**，中途回复与最终回答一致。',
        '## 二级标题 · 24px', '### 三级标题 · 20px', '#### 四级标题 · 16px', '##### 五级标题 · 14px', '###### 六级标题 · 13.6px',
        '- 列表继承正文尺寸，不单独缩小。\\n- 行内代码 ' + tick + 'session_id' + tick + ' 使用 85%。',
        '> 引用保留正文尺寸，使用边线与次级颜色。',
        '    const session = { ready: true };\\n    console.log(session);',
        '| 内容 | 字号 | 行高 |\\n| --- | --- | --- |\\n| 正文 | 16px | 24px |\\n| 代码 | 13.6px | 19.72px |'].join('\\n\\n');
      const messages = document.querySelector('#messages');
      messages.innerHTML = '<section class="turn"><div class="turn-answer"><div class="md-host"></div></div></section>';
      messages.querySelector('.md-host').innerHTML = renderMarkdownHtml(source); messages.scrollTop = 0;
    })()`);
    if (closed) await clickTodo();
    await delay(300);
    const geometry = await cdp.evaluate(`(() => {
      const turn = document.querySelector('#messages .turn');
      const composer = document.querySelector('.composer-surface');
      const messages = document.querySelector('#messages');
      const panel = document.querySelector('.workspace-panel');
      const surface = document.querySelector('.workspace-panel-surface');
      const head = document.querySelector('.workspace-panel-head');
      const body = document.querySelector('.workspace-panel-body');
      const a = turn.getBoundingClientRect(), b = composer.getBoundingClientRect();
      const m = messages.getBoundingClientRect(), p = surface.getBoundingClientRect();
      const h = head.getBoundingClientRect(), c = body.getBoundingClientRect();
      // 身份行(§1.5):在表面外下方、与表面同宽;profile chip 必须在动作行里。
      const id = document.querySelector('.composer-identity');
      const i = id == null ? null : id.getBoundingClientRect();
      const panelOpen = !panel.classList.contains('collapsed');
      const hasIdentity = i != null;
      return { leftDelta: Math.abs(a.left - b.left), rightDelta: Math.abs(a.right - b.right), messageWidth: a.width, messagesWidth: m.width, composerWidth: b.width, panelHeight: p.height, bodyBelowHeader: !panelOpen || c.top >= h.bottom - 1, overflow: document.documentElement.scrollWidth > innerWidth, panelOpen, noOverlap: p.left >= m.right - 1, identityBelowSurface: !hasIdentity || i.top >= b.bottom - 1, identityAligned: !hasIdentity || (Math.abs(i.left - b.left) <= 2 && Math.abs(i.right - b.right) <= 2), profileChip: !hasIdentity || document.querySelector('.composer-profile-button') != null };
    })()`);
    if (geometry.leftDelta > 2 || geometry.rightDelta > 2 || geometry.overflow || !geometry.noOverlap || !geometry.bodyBelowHeader
      || !geometry.identityBelowSurface || !geometry.identityAligned || !geometry.profileChip) {
      throw new Error(`${name}: alignment failed ${JSON.stringify(geometry)}`);
    }
    if (closed) {
      // Refresh the local snapshot while collapsed: the same header must survive.
      await cdp.evaluate("window.__stress.store.todos[1](window.__stress.store.todos[0]().map(item => ({ ...item })))");
      await delay(50);
      await clickTodo();
      // 右栏是真实列:展开必须推窄消息列,但绝不能盖住它;正文与输入框始终同宽。
      const motion = await cdp.evaluate(`new Promise(resolve => {
        const started = performance.now(); let worst = 0; let frames = 0, maxPanelHeight = 0, minMessagesWidth = Infinity, overlapped = false;
        function sample() {
          const a = document.querySelector('#messages .turn').getBoundingClientRect();
          const b = document.querySelector('.composer-surface').getBoundingClientRect();
          const m = document.querySelector('#messages').getBoundingClientRect();
          const surface = document.querySelector('.workspace-panel-surface').getBoundingClientRect();
          worst = Math.max(worst, Math.abs(a.left - b.left), Math.abs(a.right - b.right));
          minMessagesWidth = Math.min(minMessagesWidth, m.width);
          overlapped = overlapped || surface.left < m.right - 1;
          maxPanelHeight = Math.max(maxPanelHeight, surface.height); frames++;
          if (performance.now() - started < 300) requestAnimationFrame(sample);
          else resolve({ worst, frames, closedPanelHeight: ${geometry.panelHeight}, maxPanelHeight, minMessagesWidth, collapsedMessagesWidth: ${geometry.messagesWidth}, overlapped });
        }
        requestAnimationFrame(sample);
      })`);
      if (motion.worst > 2 || motion.overlapped || motion.maxPanelHeight <= motion.closedPanelHeight + 1 || motion.minMessagesWidth >= motion.collapsedMessagesWidth - 1) {
        throw new Error(`${name}: rail must push (never cover) the message column and expand downward ${JSON.stringify(motion)}`);
      }
      console.log(`${name}: motion ${JSON.stringify(motion)}`);
      if (!await cdp.evaluate("!document.querySelector('.workspace-panel').classList.contains('collapsed')")) throw new Error(`${name}: workspace rail did not reopen`);
      // Keyboard toggle follows the same control, without a page reload.
      await cdp.evaluate("document.querySelector('.workspace-panel-head').focus()");
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await delay(300);
      if (await cdp.evaluate("!document.querySelector('.workspace-panel').classList.contains('collapsed')")) throw new Error(`${name}: keyboard collapse failed`);
    }
    console.log(`${name}: aligned ${JSON.stringify(geometry)}`);
  }
  if (section) {
    // 按 data-section-id 点，不按位置索引：设置分区一增删，索引版就静默拍错分区
    // （pairing 曾经在第 6 项）。
    await cdp.evaluate(
      `document.querySelector('.settings-nav-item[data-section-id=${JSON.stringify(section)}]')?.click()`,
    );
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
    ["markdown-primer-light", { view: "messages", theme: "light", material: "solid", width: 1920, height: 1080, typography: true, closed: true }],
    ["markdown-primer-dark", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 1000, typography: true, closed: true }],
    ["messages-light-desktop", { view: "messages", theme: "light", material: "glass", width: 1920, height: 1080 }],
    ["messages-light-dock-closed", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, closed: true }],
    ["messages-dark-desktop", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 900 }],
    ["messages-light-1024", { view: "messages", theme: "light", material: "solid", width: 1024, height: 768 }],
    ["messages-dark-800", { view: "messages", theme: "dark", material: "solid", width: 800, height: 600 }],
    ["messages-light-640", { view: "messages", theme: "light", material: "solid", width: 640, height: 480 }],
    ["messages-dark-narrow", { view: "messages", theme: "dark", material: "glass", width: 480, height: 640 }],
    ["messages-light-125pct", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, scale: 1.25 }],
    ["messages-dark-150pct", { view: "messages", theme: "dark", material: "solid", width: 1280, height: 900, scale: 1.5 }],
    ["messages-reduced-motion", { view: "messages", theme: "light", material: "solid", width: 1280, height: 900, reduced: true, closed: true }],
    ["settings-light-solid-desktop", { view: "settings", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["settings-dark-glass-narrow", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820 }],
    ["settings-dark-glass-narrow-pairing", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820, section: "section-pairing" }],
    ["settings-dark-glass-narrow-about", { view: "settings", theme: "dark", material: "glass", width: 480, height: 820, section: "section-about" }],
    ["tools-light-solid-desktop", { view: "tools", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["tools-dark-solid-narrow", { view: "tools", theme: "dark", material: "solid", width: 480, height: 820 }],
    ["tools-light-solid-800x600", { view: "tools", theme: "light", material: "solid", width: 800, height: 600 }],
    ["tools-dark-solid-480x640", { view: "tools", theme: "dark", material: "solid", width: 480, height: 640 }],
    ["approval-light-solid-desktop", { view: "approval", theme: "light", material: "solid", width: 1280, height: 900 }],
    ["approval-light-glass-desktop", { view: "approval", theme: "light", material: "glass", width: 1280, height: 900 }],
    ["approval-dark-glass-narrow", { view: "approval", theme: "dark", material: "glass", width: 480, height: 820 }],
    ["approval-dark-solid-narrow", { view: "approval", theme: "dark", material: "solid", width: 480, height: 820 }],
    ["approval-light-solid-1024x768", { view: "approval", theme: "light", material: "solid", width: 1024, height: 768 }],
    ["approval-dark-glass-800x600", { view: "approval", theme: "dark", material: "glass", width: 800, height: 600 }],
    ["approval-light-solid-640x480", { view: "approval", theme: "light", material: "solid", width: 640, height: 480 }],
    ["approval-dark-glass-480x640", { view: "approval", theme: "dark", material: "glass", width: 480, height: 640 }],
  ];
  for (const [name, options] of scenarios) await capture(name, options);
} finally {
  cdp.socket.close();
  child.kill();
}
