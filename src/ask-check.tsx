/** 本地 dev-only 视觉验收:ask 走居中模态(#approval-slot),不连接 daemon。 */
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { ApprovalStack } from "./approval/ApprovalCards";
import { applyTheme } from "./lib/theme";
import { STR } from "./lib/strings";
import type { ApprovalView } from "./lib/transport";
import "./styles/app.css";

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "dark" ? "dark" : "light");

const askViews: ApprovalView[] = [
  {
    challenge_id: "ask-1", kind: "ask", expires_in: 0, details: { questions: [
      { id: "q1", question: "预览服务使用哪个端口?", options: ["5173", "4173"], allow_custom: true },
      { id: "q2", question: "是否包含基准对比?", options: ["包含", "跳过"], allow_custom: false },
    ] },
  },
  { challenge_id: "ask-2", kind: "ask", expires_in: 0, details: { questions: [{ id: "q3", question: "第二组问题(尚未展示)", options: ["甲", "乙"] }] } },
];
const permView: ApprovalView = { challenge_id: "perm-1", kind: "tool_permission", expires_in: 0, details: { tool_name: "exec", action_summary: "运行构建", risk: "medium", level: 2, category: "shell", reason: "写 out/ 目录" } };

const [last, setLast] = createSignal("（尚未提交）");
const [showPerm, setShowPerm] = createSignal(false);
const respond = async (challengeId: string, decision: string, payload?: Record<string, unknown>): Promise<void> => {
  setLast(JSON.stringify({ challengeId, decision, payload }));
};

render(() => (
  <main style={{ "max-width": "760px", margin: "36px auto", padding: "0 20px", display: "grid", gap: "18px" }}>
    <h2 style={{ "font-size": "16px", "font-weight": "500", margin: "0" }}>ask 居中模态</h2>
    <p style={{ color: "var(--muted)", "font-size": "13px", margin: "0" }}>
      授权/计划评审/AskUser 共用同一个遮罩栈;只展示最早一个 challenge。
    </p>
    <ApprovalStack pending={showPerm() ? [permView, ...askViews] : askViews} respond={respond} />
    <div class="ask-check-last" data-last-submit={last()} data-expected-more={STR.morePending(1)}>{last()}</div>
    <Show when={!showPerm()}>
      <button type="button" id="ask-check-show-perm" onClick={() => setShowPerm(true)}>注入模态授权</button>
    </Show>
  </main>
), document.getElementById("root")!);
