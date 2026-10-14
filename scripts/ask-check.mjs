/** Headless Edge + 真实 ApprovalStack 验收(ask 居中模态),无 daemon / 外部数据。pnpm dev 后运行。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 9343;
const base = process.env.QAQH_ASK_CHECK_URL ?? "http://localhost:5173/ask-check.html";
const out = "artifacts/ask-review";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-ask-check-"))}`,
  "--no-first-run", "--disable-extensions", "--disable-sync", "about:blank",
], { stdio: "ignore" });
let socket;
const diagnostics = [];
try {
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((p) => p.type === "page"); } catch { /* starting */ }
    if (target?.webSocketDebuggerUrl) break;
    await delay(200);
  }
  assert.ok(target?.webSocketDebuggerUrl);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === "Runtime.exceptionThrown") diagnostics.push(msg.params);
    if (msg.method === "Runtime.consoleAPICalled" && ["warning", "error"].includes(msg.params.type)) diagnostics.push(msg.params);
    const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); msg.error ? request.reject(msg.error) : request.resolve(msg.result); }
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async (expression) => {
    const point = await evaluate(`(() => { const el = ${expression}; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await delay(300);
  };
  const snapshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  await send("Runtime.enable"); await send("Page.enable");
  for (const [theme, width] of [["light", 1000], ["dark", 1000], ["light", 480], ["dark", 480]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: base + '?theme=' + theme });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.querySelectorAll('#approval-slot .card.ask').length === 1 && document.fonts.status === 'loaded'")) break;
      await delay(100);
    }
    await delay(300);
    assert.equal(await evaluate("document.querySelectorAll('#approval-slot .card.ask').length"), 1, "ask 走居中模态");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#approval-slot')).position"), "fixed", "遮罩脱离文档流,不再嵌进消息列");
    assert.equal(await evaluate("(() => { const r = document.querySelector('#approval-slot .card.ask').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()"), true, "卡片完整落在视口内");
    assert.equal(await evaluate("document.querySelectorAll('#approval-dialog-title').length"), 1, "dialog 标题 id 唯一");
    assert.equal(await evaluate("document.querySelector('#approval-slot .card-more')?.textContent"), await evaluate("document.querySelector('.ask-check-last').dataset.expectedMore"), "模态卡「还有 N 个」计数");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);

    await evaluate("(() => { const el = document.querySelector('#approval-slot [data-qid=\"q1\"] input[data-custom]'); el.value = '3000'; return true; })()");
    // 提交逻辑在点击时直接读 DOM(checked/value),无需合成 change/input 事件。
    await evaluate("(() => { const el = document.querySelector('#approval-slot [data-qid=\"q2\"] input[type=radio]'); el.checked = true; return true; })()");
    await click("document.querySelector('#approval-slot .card-actions .primary')");
    assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"),
      '{"challengeId":"ask-1","decision":"submit","payload":{"answers":[{"question_id":"q1","answer":"3000"},{"question_id":"q2","answer":"包含"}]}}',
      "自定义答案优先且逐题作答");
    await click("document.querySelector('#approval-slot .card-actions .button-secondary')");
    assert.equal(await evaluate("document.querySelector('.ask-check-last').dataset.lastSubmit"),
      '{"challengeId":"ask-1","decision":"dismiss","payload":{}}', "跳过走 dismiss");

    // 注入模态授权:同一个遮罩栈改挂授权卡,ask 退回队列尾部。
    // 遮罩 fixed inset:0 会吃掉坐标点击,这里只能走 DOM 直调。
    await evaluate("(() => { document.querySelector('#ask-check-show-perm').click(); return true; })()");
    await delay(300);
    assert.equal(await evaluate("document.querySelector('#approval-slot [role=\"dialog\"] .card.perm') != null"), true);
    assert.equal(await evaluate("document.querySelectorAll('#approval-slot .card.ask').length"), 0, "授权在队首时 ask 不展示");
    assert.equal(await evaluate("document.querySelectorAll('#approval-dialog-title').length"), 1, "dialog 标题 id 唯一");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    await snapshot(`${theme}-${width}`);
    console.log(`PASS ${theme} ${width}: modal ask / viewport containment / submit+dismiss / modal queue / overflow`);
  }
  assert.deepEqual(diagnostics, [], `运行时诊断: ${JSON.stringify(diagnostics)}`);
  console.log(`Screenshots: ${out}`);
} finally { socket?.close(); child.kill(); }
