/** Real App + mock IPC layout/composer regression checks. Run after `pnpm dev`.
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
    const typography = await evaluate("(() => { const s = getComputedStyle(document.querySelector('.md-host')); return { size: s.fontSize, height: s.lineHeight }; })()");
    assert.equal(typography.size, "12px", "Message body must use the requested 12px font");
    assert.equal(typography.height, "19.2px", "Message body must use 1.6 line spacing");
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

  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: base });
  await waitFor("Boolean(document.querySelector('.messages-empty-copy button'))");
  // Override only session IPC; keep the real App, Composer, tab store and transport.
  await evaluate(`(() => {
    const internals = window.__TAURI_INTERNALS__;
    const original = internals.invoke.bind(internals);
    const probe = window.__composerProbe = { sessions: [], creates: 0, sends: [], failCreate: true, failSend: false, deferSend: false, release: null };
    const callbacks = new Map();
    const listeners = new Map();
    let listenerId = 0;
    const transform = internals.transformCallback.bind(internals);
    internals.transformCallback = (callback, once) => {
      const id = transform(callback, once);
      callbacks.set(id, callback);
      return id;
    };
    probe.emit = (event, payload) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    internals.invoke = async (cmd, args = {}) => {
      if (cmd === 'plugin:event|listen') {
        const id = ++listenerId;
        listeners.set(id, { event: args.event, handler: args.handler });
        return id;
      }
      if (cmd === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null; }
      if (cmd === 'session_list') return structuredClone(probe.sessions);
      if (cmd === 'create_session') {
        probe.creates++;
        if (probe.failCreate) throw new Error('fixture create failure');
        probe.sessions.push({ session_id: 'composer-' + probe.creates, title: '对话 ' + probe.creates });
        return { status: 'accepted' };
      }
      if (cmd === 'timeline_status') return { status: 'open', session_id: args.seed };
      if (cmd === 'session_bootstrap') return { control: { state: { activity: 'idle' } } };
      if (cmd === 'pending_approvals') return [];
      if (cmd === 'send_message') {
        probe.sends.push({ seed: args.seed, text: args.text });
        if (probe.failSend) throw new Error('fixture send failure');
        if (probe.deferSend) await new Promise(resolve => { probe.release = resolve; });
        return { status: 'accepted' };
      }
      return original(cmd, args);
    };
  })()`);
  const typeDraft = async (text) => {
    await evaluate("document.querySelector('#composer textarea').focus(); document.querySelector('#composer textarea').select()");
    await send("Input.insertText", { text });
    await waitFor(`document.querySelector('#composer textarea').value === ${JSON.stringify(text)}`);
  };
  const clickSend = () => evaluate("document.querySelector('#composer .send').click()");
  const key = (key, options = "") => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, ${options} }))`);

  assert.equal(await evaluate("document.querySelector('.tab-add').disabled"), false, "Empty shell must expose an enabled create action");
  await capture("composer-empty-shell");
  await typeDraft("你好，先写草稿再新建对话");
  await evaluate("document.querySelector('.messages-empty-copy button').click()");
  await waitFor("Boolean(document.querySelector('.connection-notice')) && !document.querySelector('.messages-empty-copy button').disabled");
  assert.equal(await evaluate("document.querySelector('#composer textarea').value"), "你好，先写草稿再新建对话", "Failed creation must preserve the draft");
  await evaluate("window.__composerProbe.failCreate = false; document.querySelector('.messages-empty-copy button').click()");
  await waitFor("Boolean(document.querySelector('.tab.active')) && !document.querySelector('#composer .send').disabled");
  assert.equal(await evaluate("document.querySelector('#composer textarea').value"), "你好，先写草稿再新建对话", "New session must inherit the empty-shell draft");
  await clickSend();
  await waitFor("document.querySelector('#composer textarea').value === '' && document.querySelector('#composer .send').disabled");
  assert.deepEqual(await evaluate("window.__composerProbe.sends[0]"), { seed: "composer-2", text: "你好，先写草稿再新建对话" });

  await typeDraft("   ");
  assert.equal(await evaluate("document.querySelector('#composer .send').disabled"), true, "Whitespace must not enable Send");
  await typeDraft("输入法确认");
  await waitFor("!document.querySelector('#composer .send').disabled");
  await evaluate("document.querySelector('#composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))");
  assert.equal(await evaluate("window.__composerProbe.sends.length"), 1, "IME confirmation must not send");
  await evaluate("document.querySelector('#composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }))");
  assert.equal(await evaluate("window.__composerProbe.sends.length"), 1, "Shift+Enter must not send");

  await evaluate("window.__composerProbe.deferSend = true");
  await clickSend();
  await waitFor("window.__composerProbe.sends.length === 2 && Boolean(window.__composerProbe.release)");
  assert.equal(await evaluate("document.querySelector('#composer .send').disabled"), true, "Pending acknowledgement must prevent duplicate sends");
  await evaluate("document.querySelector('#composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  assert.equal(await evaluate("window.__composerProbe.sends.length"), 2, "Repeated Enter must not duplicate an in-flight send");
  await typeDraft("等待发送确认时写的下一条草稿");
  await evaluate("window.__composerProbe.deferSend = false; window.__composerProbe.release()");
  await waitFor("!document.querySelector('#composer .send').disabled");
  assert.equal(await evaluate("document.querySelector('#composer textarea').value"), "等待发送确认时写的下一条草稿", "Late acknowledgement must preserve newer text");

  await evaluate("window.__composerProbe.failSend = true");
  await clickSend();
  await waitFor("Boolean(document.querySelector('.toast.err')) && !document.querySelector('#composer .send').disabled");
  assert.equal(await evaluate("document.querySelector('#composer textarea').value"), "等待发送确认时写的下一条草稿", "Rejected send must preserve its draft");
  await evaluate("window.__composerProbe.failSend = false");
  await key("t", "ctrlKey: true");
  await waitFor("document.querySelectorAll('.tab').length === 2 && window.__composerProbe.creates === 3");
  await typeDraft("第二个会话的草稿");
  await waitFor("!document.querySelector('#composer .send').disabled");
  await clickSend();
  await waitFor("document.querySelector('#composer textarea').value === ''");
  await key("Tab", "ctrlKey: true, shiftKey: true");
  await waitFor("document.querySelector('#composer textarea').value === '等待发送确认时写的下一条草稿'");
  await key("w", "ctrlKey: true");
  await waitFor("document.querySelectorAll('.tab').length === 1");
  await key("w", "ctrlKey: true");
  await waitFor("Boolean(document.querySelector('.messages-empty-copy button'))");
  await key("t", "ctrlKey: true");
  await waitFor("Boolean(document.querySelector('.tab.active')) && window.__composerProbe.creates === 4");
  await capture("composer-created-session");
  console.log("PASS composer: empty-session create/retry, reactive drafts, successful clear, whitespace/IME guards, duplicate-send prevention, late/rejected acknowledgements, tab isolation, Ctrl+T with no tabs");

  // Reuse the existing message timeline: exactly one four-line thinking scroller,
  // with full history, and no second rendering beside the composer.
  await evaluate(`(() => {
    const probe = window.__composerProbe;
    const seed = probe.sessions.at(-1).session_id;
    let seq = 0;
    const feed = event => probe.emit('timeline://entry', { session_id: seed, entry: { timeline_seq: ++seq, turn_id: 'width-check', event } });
    window.__reasoningProbe = { feed };
    feed({ type: 'block_opened', block: { block_id: 'width-reasoning', kind: 'reasoning', state: 'open' } });
    feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '短思考' });
  })()`);
  await waitFor("document.querySelector('#messages .thinking-full')?.textContent === '短思考'");
  assert.equal(await evaluate("document.querySelector('.thinking-chain')"), null, "Bottom thinking strip must be removed");
  assert.equal(await evaluate("document.querySelectorAll('.thinking-full').length"), 1, "The existing timeline must render each reasoning block once");
  const reasoningBounds = () => evaluate(`(() => {
    const selectors = ['.workspace-content', '.session-tabs-region', '.session-column', '#session', '#messages', '#composer', '.thinking-full'];
    const result = {};
    for (const selector of selectors) {
      const r = document.querySelector(selector).getBoundingClientRect();
      result[selector] = { left: r.left, right: r.right, width: r.width };
    }
    const scroller = document.querySelector('.thinking-full');
    result.scroller = { height: scroller.clientHeight, lineHeight: parseFloat(getComputedStyle(scroller).lineHeight), top: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight, chars: scroller.textContent.length, tail: scroller.textContent.slice(-100) };
    return result;
  })()`);
  for (const [width, height] of [[1920, 1000], [1280, 800], [480, 640]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.__reasoningProbe.feed({ type: 'block_checkpoint', block_id: 'width-reasoning', text: '短思考' })");
    await waitFor("document.querySelector('.thinking-full')?.textContent === '短思考'");
    const before = await reasoningBounds();
    for (const [name, text] of [
      ['cjk', '很长的思考内容'.repeat(4000) + '可见的最新结尾'],
      ['path', 'C:\\workspace\\deeply-nested-directory\\filename-without-spaces.txt'.repeat(4000) + '-latest-end'],
      ['mixed', 'Thinking about中文代码与路径 '.repeat(4000) + 'latest-最新结尾'],
    ]) {
      await evaluate(`window.__reasoningProbe.feed({ type: 'block_checkpoint', block_id: 'width-reasoning', text: ${JSON.stringify(text)} })`);
      await waitFor(`document.querySelector('.thinking-full')?.textContent === ${JSON.stringify(text)}`);
      await waitFor("(() => { const el = document.querySelector('.thinking-full'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 2; })()");
      const after = await reasoningBounds();
      for (const selector of ['.session-tabs-region', '.session-column', '#session', '#messages', '#composer', '.thinking-full']) {
        assert.ok(Math.abs(after[selector].left - before[selector].left) < 1, `Long ${name} reasoning must not move ${selector}: ${JSON.stringify({ before: before[selector], after: after[selector] })}`);
        assert.ok(Math.abs(after[selector].width - before[selector].width) < 1, `Long ${name} reasoning must not expand ${selector}: ${JSON.stringify({ before: before[selector], after: after[selector] })}`);
        assert.ok(after[selector].right <= after['.workspace-content'].right + 1, `${selector} must remain inside the workspace`);
      }
      assert.ok(after.scroller.height <= after.scroller.lineHeight * 4 + 1, "Reasoning viewport must be no taller than four wrapped lines");
      assert.equal(after.scroller.chars, text.length, "Scrolling must expose the full reasoning history");
    }
    await capture(`thinking-long-${width}`);
    await evaluate("window.__reasoningProbe.feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '\\n' })");
    await waitFor("document.querySelector('.thinking-full').textContent.endsWith('latest-最新结尾\\n')");
    console.log(`PASS reasoning ${width}x${height}: four-line message viewport, full history, long CJK/path/mixed text without layout shifts`);
  }

  const history = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行思考`).join("\n");
  await evaluate(`window.__reasoningProbe.feed({ type: 'block_checkpoint', block_id: 'width-reasoning', text: ${JSON.stringify(history)} })`);
  await waitFor("(() => { const el = document.querySelector('.thinking-full'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 2; })()");
  let scroll = (await reasoningBounds()).scroller;
  assert.ok(Math.abs(scroll.height / scroll.lineHeight - 4) < 0.1, "Long thinking must display four lines");
  await evaluate("(() => { const el = document.querySelector('.thinking-full'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); })()");
  await evaluate("(async () => { window.__reasoningProbe.feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '\\n第 41 行思考' }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()");
  scroll = (await reasoningBounds()).scroller;
  assert.equal(scroll.top, 0, "New streaming text must not pull the user away from earlier thinking");
  assert.ok(scroll.tail.endsWith("第 41 行思考"), "Thinking must continue streaming while reviewing history");
  await evaluate("(() => { const el = document.querySelector('.thinking-full'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); window.__reasoningProbe.feed({ type: 'text_delta', block_id: 'width-reasoning', delta: '\\n第 42 行思考' }); })()");
  await waitFor("(() => { const el = document.querySelector('.thinking-full'); return el.textContent.endsWith('第 42 行思考') && el.scrollHeight - el.scrollTop - el.clientHeight <= 2; })()");
  await capture("thinking-four-lines-history");

  await evaluate("document.querySelector('.timeline-row.thinking .timeline-label').click()");
  await waitFor("document.querySelector('.thinking-full') == null");
  await evaluate("document.querySelector('.timeline-row.thinking .timeline-label').click()");
  await waitFor("document.querySelector('.thinking-full')?.textContent.endsWith('第 42 行思考')");
  await evaluate("window.__reasoningProbe.feed({ type: 'block_sealed', block_id: 'width-reasoning' })");
  assert.equal(await evaluate("document.querySelectorAll('.thinking-full').length"), 1, "Manually opened thinking should remain available after sealing");
  await evaluate("window.__reasoningProbe.feed({ type: 'turn_sealed', state: 'completed' })");
  await waitFor("document.querySelector('.thinking-full') == null");
  await evaluate("document.querySelector('.work-group .collapsed-row').click()");
  await waitFor("Boolean(document.querySelector('.timeline-row.thinking .timeline-label'))");
  await evaluate("document.querySelector('.timeline-row.thinking .timeline-label').click()");
  await waitFor("document.querySelector('.thinking-full')?.textContent.endsWith('第 42 行思考')");
  assert.equal((await reasoningBounds()).scroller.chars, (history + '\n第 41 行思考\n第 42 行思考').length, "Completed thinking must retain its full history");
  console.log("PASS thinking: auto-open, latest four lines, scroll-up pauses following, bottom resumes, collapse/reopen and completed history, no duplicate/footer rendering");
} finally {
  socket?.close();
  child.kill();
}
