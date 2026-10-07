/**
 * 授权窗口与 AskUser(spec §11):居中阻塞对话框,保留会话消息作为背景上下文。
 * 不折叠、不截断;长内容在卡片正文内滚动,操作栏始终属于卡片本身;
 * 待处理状态完全由后端 approvals RPC 重建(重连/切标签后仍在)。
 *
 * [契约缺口 A-1] spec §11.2 要求按钮只渲染后端 choices[];网关 challenge
 * details 目前不携带 choices,合法决策集由网关 command_for 固定
 * (approve/reject/trust;submit/dismiss;approve/reject),此处与之对齐。
 * 后端补 choices 后按列表渲染即可。
 */
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { ApprovalView } from "../lib/transport";
import { STR } from "../lib/strings";

function isHighRisk(view: ApprovalView): boolean {
  return String(view.details?.risk ?? "").toLowerCase() === "high";
}

/** 卡片键盘:焦点在卡片内 Enter=主操作、Esc=拒绝;high risk 禁用 Enter。 */
function useCardKeys(highRisk: () => boolean, onPrimary: () => void, onReject: () => void, rootRef: () => HTMLElement | undefined): void {
  createEffect(
    rootRef,
    (root) => {
      if (root == null) return;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Enter" && !event.isComposing) {
          if (highRisk()) return;
          event.preventDefault();
          onPrimary();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onReject();
        }
      };
      root.addEventListener("keydown", onKey);
      return () => root.removeEventListener("keydown", onKey);
    },
  );
}

export const ApprovalCard: Component<{ view: ApprovalView; pendingCount: number; busy: () => boolean; error: () => string | null; respond: (decision: string) => void }> = (props) => {
  let root: HTMLDivElement | undefined;
  const details = () => props.view.details ?? {};
  useCardKeys(() => isHighRisk(props.view), () => props.respond("approve"), () => props.respond("reject"), () => root);
  return (
    <div class={{ card: true, perm: true, high: isHighRisk(props.view) }} tabindex={-1} ref={root}>
      <div class="card-head">
        <span id="approval-dialog-title">{STR.approvalTitle}</span>
        <Show when={isHighRisk(props.view)}>
          <b class="card-risk">{STR.highRisk}</b>
        </Show>
        <Show when={props.pendingCount > 1}>
          <span class="card-more">{STR.morePending(props.pendingCount - 1)}</span>
        </Show>
      </div>
      <div class="card-body">
        <div class="card-tool"><b>{details().tool_name ?? "unknown"}</b><Show when={details().action_summary}>{` · ${details().action_summary}`}</Show></div>
        <Show when={details().reason}>
          <div class="card-line"><span class="card-key">{STR.reason}</span>{details().reason}</div>
        </Show>
        <Show when={Array.isArray(details().paths) && details().paths.length > 0}>
          <pre class="card-paths">{(details().paths as string[]).join("\n")}</pre>
        </Show>
        <div class="card-line">
          <span class="card-key">{STR.riskLabel}</span>
          {`${details().risk ?? "?"} · ${details().level_name || `level ${details().level ?? "?"}`} · ${details().category ?? "?"}`}
        </div>
        <Show when={details().consequence}>
          <div class="card-line"><span class="card-key">{STR.consequence}</span>{details().consequence}</div>
        </Show>
        <Show when={props.error() != null}><p class="card-error" role="alert">{props.error()}</p></Show>
      </div>
      <div class="card-actions" aria-busy={props.busy() ? "true" : "false"}>
        <button type="button" class="primary button-primary" disabled={props.busy()} onClick={() => props.respond("approve")}>{STR.allowOnce}</button>
        <button type="button" class="button-secondary" disabled={props.busy()} onClick={() => props.respond("reject")}>{STR.reject}</button>
        <button type="button" class="button-secondary" disabled={props.busy()} onClick={() => props.respond("trust")}>{STR.allowTrust}</button>
      </div>
    </div>
  );
};

export const AskCard: Component<{ view: ApprovalView; pendingCount: number; busy: () => boolean; error: () => string | null; respond: (payload: Record<string, unknown>) => void; skip: () => void }> = (props) => {
  let root: HTMLDivElement | undefined;
  const [validationError, setValidationError] = createSignal(false);
  const questions = (): Array<Record<string, any>> => (Array.isArray(props.view.details?.questions) ? props.view.details.questions : []);
  const submit = (): void => {
    const answers: Array<{ question_id: string; answer: string }> = [];
    for (const question of questions()) {
      const id = String(question.id ?? "");
      if (!id) continue;
      const rootEl = root?.querySelector<HTMLElement>(`[data-qid="${CSS.escape(id)}"]`);
      const custom = rootEl?.querySelector<HTMLInputElement>("input[data-custom]")?.value.trim() ?? "";
      const picked = rootEl?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value;
      // 空的自定义输入框不能覆盖用户选中的 radio 选项。
      const answer = custom || picked || "";
      if (answer === "") {
        setValidationError(true);
        (rootEl?.querySelector<HTMLElement>("input[data-custom], input[type=radio]") ?? root)?.focus();
        return;
      }
      answers.push({ question_id: id, answer });
    }
    setValidationError(false);
    props.respond({ answers });
  };
  useCardKeys(() => false, submit, props.skip, () => root);
  return (
    <div class="card ask" tabindex={-1} ref={root}>
      <div class="card-head"><span id="approval-dialog-title">{STR.askTitle}</span><Show when={props.pendingCount > 1}><span class="card-more">{STR.morePending(props.pendingCount - 1)}</span></Show></div>
      <div class="card-body">
        <Show when={questions().length === 0}>
          <div class="card-line">(缺少问题详情)</div>
        </Show>
        <For each={questions()}>
          {(question) => (
            <div class="card-q" data-qid={String(question.id ?? "")}>
              <div class="card-q-text">{question.question}</div>
              <Show when={Array.isArray(question.options) && question.options.length > 0}>
                <div class="card-opts">
                  <For each={question.options}>
                    {(option: string) => (
                      <label class="card-opt">
                        <input type="radio" name={`q-${String(question.id)}`} value={option} onChange={() => setValidationError(false)} />
                        <span>{option}</span>
                      </label>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={question.allow_custom !== false}>
                <input class="card-custom" type="text" data-custom placeholder={STR.customAnswer} onInput={() => setValidationError(false)} />
              </Show>
            </div>
          )}
        </For>
        <Show when={validationError()}><p class="card-error" role="alert">{STR.askAnswerRequired}</p></Show>
        <Show when={props.error() != null}><p class="card-error" role="alert">{props.error()}</p></Show>
      </div>
      <div class="card-actions" aria-busy={props.busy() ? "true" : "false"}>
        <button type="button" class="primary button-primary" disabled={props.busy()} onClick={submit}>{STR.submit}</button>
        <button type="button" class="button-secondary" disabled={props.busy()} onClick={props.skip}>{STR.skip}</button>
      </div>
    </div>
  );
};

export const PlanCard: Component<{ view: ApprovalView; pendingCount: number; busy: () => boolean; error: () => string | null; respond: (approved: boolean, message: string, autonomous: boolean) => void }> = (props) => {
  let root: HTMLDivElement | undefined;
  const [message, setMessage] = createSignal("");
  const [autonomous, setAutonomous] = createSignal(false);
  useCardKeys(() => false, () => props.respond(true, message(), autonomous()), () => props.respond(false, message(), autonomous()), () => root);
  return (
    <div class="card plan" tabindex={-1} ref={root}>
      <div class="card-head"><span id="approval-dialog-title">{STR.planTitle}</span><Show when={props.pendingCount > 1}><span class="card-more">{STR.morePending(props.pendingCount - 1)}</span></Show></div>
      <div class="card-body">
        <pre class="card-plan">{props.view.details?.plan_content ?? "(缺少计划内容)"}</pre>
        <input class="card-message" type="text" placeholder={STR.planPlaceholder} value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
        <label class="card-opt">
          <input type="checkbox" checked={autonomous()} onInput={(e) => setAutonomous(e.currentTarget.checked)} />
          <span>{STR.autonomous}</span>
        </label>
        <Show when={props.error() != null}><p class="card-error" role="alert">{props.error()}</p></Show>
      </div>
      <div class="card-actions" aria-busy={props.busy() ? "true" : "false"}>
        <button type="button" class="primary button-primary" disabled={props.busy()} onClick={() => props.respond(true, message(), autonomous())}>{STR.allowOnce}</button>
        <button type="button" class="button-secondary" disabled={props.busy()} onClick={() => props.respond(false, message(), autonomous())}>{STR.reject}</button>
      </div>
    </div>
  );
};

/** 卡片组:只展示最早一个,头部显示「还有 N 个待处理」;滚动滚入视野。 */
export const ApprovalStack: Component<{ pending: ApprovalView[]; respond: (challengeId: string, decision: string, payload?: Record<string, unknown>) => Promise<void> }> = (props) => {
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let root: HTMLDivElement | undefined;
  const head = createMemo(() => props.pending[0] ?? null);
  createEffect(
    () => props.pending.length,
    (count) => {
      // 焦点在 body 时才自动聚焦卡片(§11.1),不抢输入框。
      if (count > 0 && document.activeElement === document.body) {
        root?.querySelector<HTMLElement>(".card")?.focus();
      }
    },
  );
  const send = async (view: ApprovalView, decision: string, payload: Record<string, unknown> = {}): Promise<void> => {
    setBusyId(view.challenge_id);
    setError(null);
    try {
      await props.respond(view.challenge_id, decision, payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };
  const busy = (id: string) => busyId() === id;
  const trapTab = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget as HTMLElement;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first == null || last == null) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div id="approval-slot" ref={root}>
      {/* keyed:换一个 challenge 就是一张新卡(内部草稿/展开态不该串到下一个请求) */}
      <Show when={head()} keyed>
        {(view) => (
          <div class="approval-wrap" role="dialog" aria-modal="true" aria-labelledby="approval-dialog-title" tabindex={-1} onKeyDown={trapTab}>
            {view.kind === "tool_permission" ? (
              <ApprovalCard view={view} pendingCount={props.pending.length} busy={() => busy(view.challenge_id)} error={error} respond={(decision) => void send(view, decision)} />
            ) : view.kind === "plan" ? (
              <PlanCard view={view} pendingCount={props.pending.length} busy={() => busy(view.challenge_id)} error={error} respond={(approved, message, autonomous) => void send(view, approved ? "approve" : "reject", { message: message || null, autonomous })} />
            ) : (
              <AskCard view={view} pendingCount={props.pending.length} busy={() => busy(view.challenge_id)} error={error} respond={(payload) => void send(view, "submit", payload)} skip={() => void send(view, "dismiss")} />
            )}
          </div>
        )}
      </Show>
    </div>
  );
};
