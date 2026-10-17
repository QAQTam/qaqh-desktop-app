/**
 * 一次性复核用：把「接入」页截一张图（含翻面后的账号卡）。
 *
 * 与 `visual-capture.mjs` 的区别：只拍这一张、不改动 `artifacts/ui-visual-review/`
 * 里已入库的视觉基线，并在应用脚本之前把 Tauri 判定 stub 成真——否则接入页
 * 只会渲染「浏览器预览下不可用」的兜底文案。
 *
 * 用法（dev server 需已在跑）：
 *   node scripts/oauth-shot.mjs
 * 环境变量：QAQH_SHOT_URL / QAQH_SHOT_OUT / QAQH_SHOT_VIEW / QAQH_EDGE
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EDGE = process.env.QAQH_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = Number(process.env.QAQH_SHOT_CDP_PORT ?? "9335");
const BASE = process.env.QAQH_SHOT_URL ?? "http://127.0.0.1:5173/stress.html";
const VIEW = process.env.QAQH_SHOT_VIEW ?? "oauth";
const OUT = resolve(process.env.QAQH_SHOT_OUT ?? "artifacts/oauth-check.png");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const child = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "qaqh-shot-"))}`,
    "--window-size=1280,1400",
    "--no-first-run",
    "--disable-extensions",
    "--disable-sync",
    "--no-default-browser-check",
    BASE,
  ],
  { stdio: "ignore" },
);

let target;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    target = pages.find((page) => page.type === "page" && page.url.startsWith(BASE));
    if (target?.webSocketDebuggerUrl) break;
  } catch {
    /* Edge 还在启动 */
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
const send = (method, params = {}) =>
  new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  // 必须在应用脚本之前：`isTauriRuntime()` 只看这个全局。
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      // 自带 invoke 桩：预览 RPC 层会把 dsaccount.* 拒掉，接入页只能停在
      // 「正在读取账号状态」。这里直接扮演宿主，答出一份**已登录**的投影
      // （投影里永远没有凭据字段——后端在类型层就不下发）。
      const FIXTURES = {
        "config.load": { credential: "deepseek_account", model: "deepseek-flash", reasoningEffort: "high", wire: "chat", baseUrl: "https://api.deepseek.com", contextLength: 1000000, profiles: [], activeProfile: null },
        "siwc.status": null,
        "dsaccount.status": {
          signedIn: true,
          account: { user_id: "fixture-user", label: "Fixture 用户", provider: "WECHAT", currency: "CNY", inference_origin: "https://api.deepseek.com", saved_at_ms: Date.now(), has_credential: true },
          storageError: null, inferenceOrigin: "https://api.deepseek.com",
          usageUrl: "https://platform.deepseek.com/usage", topUpUrl: "https://platform.deepseek.com/top_up",
          flow: { attemptId: null, state: "idle", authorizeUrl: null, expiresAtMs: 0, error: null },
        },
        "dsaccount.balance": {
          recharge: [{ currency: "CNY", balance: "0E-16", tokenEstimation: "0" }],
          bonus: [{ currency: "CNY", balance: "0", tokenEstimation: "0" }],
          totalCost: [{ currency: "CNY", amount: "5.9028406400000000" }],
          hasUsableBalance: false,
        },
        "dsaccount.bonuses": [],
        "dsaccount.models": [
          { id: "deepseek-flash", display_name: "DeepSeek Flash" },
          { id: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro" },
        ],
      };
      window.__TAURI_INTERNALS__ = {
        invoke: (cmd, args) => {
          if (cmd !== "service_rpc") return Promise.resolve(null);
          const method = args?.method;
          if (!(method in FIXTURES)) return Promise.reject(new Error("no fixture for " + method));
          return Promise.resolve(FIXTURES[method]);
        },
        transformCallback: (callback) => callback,
      };
    `,
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 1400,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}?view=${VIEW}&theme=light&material=solid` });

  let cards = 0;
  for (let i = 0; i < 300; i++) {
    cards = (await evaluate("document.querySelectorAll('.oauth-card').length")) ?? 0;
    if (cards >= 2 && (await evaluate("document.fonts.status === 'loaded'"))) break;
    await delay(100);
  }
  console.log(`[shot] provider cards: ${cards}`);
  console.log(
    `[shot] providers: ${JSON.stringify(await evaluate("[...document.querySelectorAll('.oauth-card')].map((c) => c.dataset.provider)"))}`,
  );
  // 翻开每一张卡：账号卡在背面，正面对评审没有信息量。
  // 直接加 `is-flipped`（纯 CSS 驱动）而不是点按钮——`.click()` 在无头下没触发翻转。
  await evaluate("document.querySelectorAll('.oauth-card').forEach((c) => c.classList.add('is-flipped'))");
  await delay(600);
  console.log(
    `[shot] 背面账号卡：${JSON.stringify(await evaluate("[...document.querySelectorAll('.oauth-card__back')].map((b) => ({ provider: b.closest('.oauth-card').dataset.provider, cards: b.querySelectorAll('.siwc-card').length, rows: b.querySelectorAll('.dsaccount-rows .dsaccount-row').length, text: b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) }))"))}`,
  );
  console.log(
    `[shot] 页面外层是否有游离的 siwc-card：${await evaluate("[...document.querySelectorAll('.siwc-card')].filter((c) => c.closest('.oauth-card') == null).length")}`,
  );
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
  });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(data, "base64"));
  console.log(`[shot] ${OUT}`);
} finally {
  socket.close();
  child.kill();
}
process.exit(0);
