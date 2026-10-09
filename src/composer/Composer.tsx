/**
 * 输入区(spec §12):1–8 行自动增高,Enter 发送 / Shift+Enter 换行,
 * 输入法组合态(isComposing / keyCode 229)不发送;
 * 运行中或有待处理请求时发送禁用(可继续写草稿);离线禁用并说明原因;
 * 空闲显示「发送」,运行中替换为「停止」。
 */
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import IconArrowUp from "~icons/lucide/arrow-up";
import IconSquare from "~icons/lucide/square";
import IconPlus from "~icons/lucide/plus";
import IconPaperclip from "~icons/lucide/paperclip";
import IconShield from "~icons/lucide/shield";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconArchive from "~icons/lucide/archive";
import IconFolder from "~icons/lucide/folder";
import IconFolderPlus from "~icons/lucide/folder-plus";
import IconX from "~icons/lucide/x";
import { STR } from "../lib/strings";
import type { SidebarWorkspace } from "../tabs/store";
import type { ComposerMetrics, PendingAttachment } from "../session/store";

export type SendBlockReason = "running" | "pending" | "offline" | "no-session" | null;

/** 路径尾段(与侧栏分组同名规则一致):`E:\code\qaqh\` → `qaqh`。 */
const tailName = (path: string): string => {
  const value = path.replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
};

/** HUD 里端点原生 usage 字段的展示上限,其余归入 `+N` 的 title。 */
const EXTRA_HUD_LIMIT = 4;

/** 附件 chip 的副标:上传态优先,完成后才显示体积。 */
function attachmentDetail(item: PendingAttachment): string {
  if (item.state === "uploading") return STR.attachmentUploading;
  if (item.state === "failed") return STR.attachmentFailed;
  return item.size > 0 ? humanSize(item.size) : "";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const Composer: Component<{
  draft: () => string;
  onDraft: (value: string) => void;
  blocked: () => SendBlockReason;
  running: () => boolean;
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
  focusToken: number;
  autoFocus?: boolean;
  placeholder?: string;
  /** Stress-page design study; production controls remain hidden until transport support lands. */
  showDesignControls?: boolean;
  /**
   * 新建会话的目标工作区。传了 `onWorkspace` 才渲染选择器(夹具页不传即无此控件)。
   * 只影响之后新建的会话:已开会话的 cwd 钉在 SessionMeta 上,不在这一处改。
   */
  workspaces?: () => SidebarWorkspace[];
  workspacePath?: () => string | null;
  onWorkspace?: (path: string | null) => void;
  onBrowseWorkspace?: () => void;
  /** Live session usage HUD; omitted from the empty-session composer. */
  metrics?: () => ComposerMetrics;
  /** 上下文面板里的「压缩上下文」;未接宿主(夹具页)时不传即隐藏。 */
  onCompact?: () => void;
  /** 压缩进行态,用于禁用重复触发。 */
  compactPhase?: () => "idle" | "running" | "done" | "skipped" | "failed";
  /**
   * 附件:选文件(内含宿主对话框 + 上传)。不传则不渲染附件入口——夹具页与
   * 浏览器预览没有原生对话框,拿不到这一面。
   */
  onPickAttachments?: () => void;
  /** 待发附件 chip 列表(上传态由 store 维护)。 */
  attachments?: () => PendingAttachment[];
  onRemoveAttachment?: (id: string) => void;
}> = (props) => {
  let textarea: HTMLTextAreaElement | undefined;
  const [openMenu, setOpenMenu] = createSignal<"profile" | "model" | "permission" | "workspace" | "context" | null>(null);
  const [profile, setProfile] = createSignal("本地模型");
  const [model, setModel] = createSignal("qaqh-visual-preview");
  const [permission, setPermission] = createSignal("workspace-write");
  const [submitting, setSubmitting] = createSignal(false);

  const attachments = (): PendingAttachment[] => props.attachments?.() ?? [];
  /** 还在上传的附件不能发:命令里只允许出现已换回的 `ContentRef`。 */
  const uploading = (): boolean => attachments().some((item) => item.state === "uploading");
  /** 未新建会话时没有可上传的目标(上传按 seed 归属),此时不摆出附件入口。 */
  const canAttach = (): boolean => props.onPickAttachments != null && props.blocked() !== "no-session";

  const workspaceLabel = (): string => {
    const path = props.workspacePath?.() ?? "";
    return path === "" ? STR.workspaceUngrouped : tailName(path);
  };

  const autoGrow = (): void => {
    const el = textarea;
    if (el == null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22 + 20)}px`; // ≈8 行后内部滚动
  };

  createEffect(() => props.draft(), () => autoGrow());

  // 新会话打开/切回标签时恢复焦点(§12)。
  createEffect(
    () => props.focusToken,
    () => { if (props.autoFocus !== false) textarea?.focus(); },
  );

  const submit = async (): Promise<void> => {
    if (submitting()) return;
    if (!props.draft().trim()) return;
    if (props.blocked() != null) return;
    if (uploading()) return;
    setSubmitting(true);
    try {
      await props.onSend(props.draft());
    } finally {
      setSubmitting(false);
    }
  };

  const blockTitle = (): string => {
    switch (props.blocked()) {
      case "running":
        return STR.sendDisabledRunning;
      case "pending":
        return STR.sendDisabledApproval;
      case "offline":
        return STR.sendDisabledOffline;
      case "no-session":
        return STR.sendDisabledNoSession;
      default:
        return STR.send;
    }
  };

  return (
    <div id="composer" class={props.showDesignControls === true ? "composer-design-preview" : undefined}>
      <div class="composer-surface">
        <Show when={attachments().length > 0}>
          <div class="composer-attachments" aria-label="待发送附件">
            <For each={attachments()}>{(item) => (
              <span class={`composer-file-chip ${item.state}`} title={item.error ?? item.name}>
                <IconPaperclip />
                <span>{item.name}</span>
                <small>{attachmentDetail(item)}</small>
                <button type="button" aria-label={`移除 ${item.name}`} onClick={() => props.onRemoveAttachment?.(item.id)}><IconX /></button>
              </span>
            )}</For>
          </div>
        </Show>
        <textarea
          ref={textarea}
          rows={1}
          placeholder={props.placeholder ?? ""}
          value={props.draft()}
          onInput={(e) => props.onDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            // 输入法组合态不发送(§12):isComposing 或 keyCode 229。
            if (e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            void submit();
          }}
        />
        <div class="composer-toolbar">
          <div class="composer-controls">
            <Show when={props.onWorkspace != null}>
              <div class="composer-control-wrap">
                <button
                  type="button"
                  class="composer-tool-button composer-workspace-button"
                  aria-expanded={openMenu() === "workspace" ? "true" : "false"}
                  title={STR.workspacePickTitle(workspaceLabel())}
                  onClick={() => setOpenMenu(openMenu() === "workspace" ? null : "workspace")}
                >
                  <IconFolder /><span>{workspaceLabel()}</span><IconChevronDown />
                </button>
                <Show when={openMenu() === "workspace"}>
                  <div class="composer-menu composer-workspace-menu" role="menu">
                    <strong>{STR.workspacePickMenu}</strong>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={props.workspacePath?.() == null ? "true" : "false"}
                      class={props.workspacePath?.() == null ? "selected" : undefined}
                      onClick={() => { props.onWorkspace?.(null); setOpenMenu(null); }}
                    >
                      <span>{STR.workspaceUngrouped}</span><small>{STR.workspaceDefaultHint}</small>
                    </button>
                    <For each={props.workspaces?.() ?? []}>{(workspace) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={props.workspacePath?.() === workspace.path ? "true" : "false"}
                        class={props.workspacePath?.() === workspace.path ? "selected" : undefined}
                        onClick={() => { props.onWorkspace?.(workspace.path); setOpenMenu(null); }}
                      >
                        <span>{workspace.title || tailName(workspace.path)}</span>
                        <small class="composer-workspace-path">{workspace.path}</small>
                      </button>
                    )}</For>
                    <button
                      type="button"
                      class="composer-menu-action"
                      onClick={() => { setOpenMenu(null); props.onBrowseWorkspace?.(); }}
                    >
                      <span class="composer-workspace-browse"><IconFolderPlus />{STR.workspaceChooseFolder}</span>
                      <small>{STR.workspaceChooseFolderHint}</small>
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={canAttach()}>
              <button
                type="button"
                class="composer-tool-button composer-add-file"
                aria-label={STR.attachmentAdd}
                title={STR.attachmentAddTitle}
                onClick={() => props.onPickAttachments?.()}
              >
                <IconPlus />
              </button>
            </Show>
            <Show when={props.showDesignControls}>
              <div class="composer-control-wrap">
                <button type="button" class="composer-tool-button" aria-expanded={openMenu() === "permission" ? "true" : "false"} onClick={() => { setOpenMenu(openMenu() === "permission" ? null : "permission"); }}>
                  <IconShield /><span>{permission()}</span><IconChevronDown />
                </button>
                <Show when={openMenu() === "permission"}>
                  <div class="composer-menu" role="menu">
                    <strong>授权档位</strong>
                    <For each={[["read-only", "只读：写入与 exec 均需授权"], ["workspace-write", "工作区内写放行；跨区、exec、网络需授权"], ["skip-permissions", "普通工具全部自动放行；危险 bypass"]]}>{([name, detail]) => (
                      <button type="button" role="menuitemradio" aria-checked={permission() === name ? "true" : "false"} class={permission() === name ? "selected" : undefined} onClick={() => { setPermission(name!); setOpenMenu(null); }}>
                        <span>{name}</span><small>{detail}</small>
                      </button>
                    )}</For>
                    <small class="composer-menu-note">原型选择，仅展示交互；实际档位仍由设置页管理。</small>
                  </div>
                </Show>
              </div>
              <div class="composer-control-wrap">
                <button type="button" class="composer-tool-button" aria-expanded={openMenu() === "profile" ? "true" : "false"} onClick={() => { setOpenMenu(openMenu() === "profile" ? null : "profile"); }}>
                  <span class="composer-config-label">配置</span><span>{profile()}</span><IconChevronDown />
                </button>
                <Show when={openMenu() === "profile"}>
                  <div class="composer-menu" role="menu">
                    <strong>BYOK 配置文件</strong>
                    <For each={["本地模型", "视觉验收", "OpenAI 兼容"]}>{(name) => (
                      <button type="button" role="menuitemradio" aria-checked={profile() === name ? "true" : "false"} class={profile() === name ? "selected" : undefined} onClick={() => { setProfile(name); setOpenMenu(null); }}>
                        <span>{name}</span><small>{name === "本地模型" ? "localhost · OpenAI 兼容" : name === "视觉验收" ? "api.example.test · Responses" : "自定义 endpoint"}</small>
                      </button>
                    )}</For>
                    <small class="composer-menu-note">配置文件切换会同时应用 endpoint、wire 和密钥。</small>
                  </div>
                </Show>
              </div>
              <div class="composer-control-wrap composer-model-wrap">
                <button type="button" class="composer-tool-button composer-model-button" aria-expanded={openMenu() === "model" ? "true" : "false"} onClick={() => { setOpenMenu(openMenu() === "model" ? null : "model"); }}>
                  <span>{model()}</span><IconChevronDown />
                </button>
                <Show when={openMenu() === "model"}>
                  <div class="composer-menu composer-menu-right" role="menu">
                    <strong>模型</strong>
                    <For each={["qaqh-visual-preview", "gpt-4.1", "自定义模型 ID…"]}>{(name) => (
                      <button type="button" role="menuitemradio" aria-checked={model() === name ? "true" : "false"} class={model() === name ? "selected" : undefined} onClick={() => { setModel(name); setOpenMenu(null); }}><span>{name}</span></button>
                    )}</For>
                    <small class="composer-menu-note">模型 ID 来自当前 BYOK 配置。</small>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
          <div class="composer-submit-area">
            <Show when={props.showDesignControls}><span class="composer-preview-label">交互原型</span><span class="composer-shortcut-hint">Enter 发送 · Shift+Enter 换行</span></Show>
        <Show
          when={props.running()}
          fallback={
            <button
              type="button"
              class="icon-btn send button-primary"
              aria-label={props.blocked() == null ? STR.send : `${STR.send}，${blockTitle()}`}
              title={uploading() ? STR.attachmentUploading : blockTitle()}
              disabled={submitting() || props.draft().trim() === "" || props.blocked() != null || uploading()}
              onClick={() => void submit()}
            >
              <IconArrowUp />
            </button>
          }
        >
          <button type="button" class="icon-btn stop button-danger" aria-label={STR.stop} title={STR.stop} onClick={() => props.onStop()}>
            <IconSquare />
          </button>
        </Show>
          </div>
        </div>
        <Show when={props.metrics?.()}>
          {(metrics) => {
            // 端点原生 usage 字段（`credit` 等未建模项）。零值通常是「未使用」，
            // 占位不提供信息，故省略；展示上限之外的完整列表进 title。
            const extras = (): Array<[string, number]> =>
              Object.entries(metrics().extras ?? {})
                .filter(([, value]) => value !== 0)
                .sort(([a], [b]) => a.localeCompare(b));
            return (
              <div class="composer-metrics" aria-label="模型运行指标">
                <Show when={metrics().tokensPerSecond != null}>
                  <span title="completion tokens ÷ 前端观察到的首末答案增量间隔；SSE 网络缓冲可能影响读数">
                    <strong>{metrics().tokensPerSecond!.toFixed(1)}</strong> tok/s
                  </span>
                </Show>
                <Show when={metrics().contextPercent != null}>
                  <span class="composer-context-wrap">
                    <button
                      type="button"
                      class="composer-context-trigger"
                      aria-expanded={openMenu() === "context" ? "true" : "false"}
                      title="上下文窗口：点开查看占用与压缩"
                      onClick={() => setOpenMenu(openMenu() === "context" ? null : "context")}
                    >
                      上下文 <strong>{metrics().contextPercent!.toFixed(0)}%</strong>
                    </button>
                    <Show when={openMenu() === "context"}>
                      <div class="composer-menu composer-context-menu" role="dialog" aria-label={STR.contextWindowTitle}>
                        <div class="composer-context-head">
                          <strong>{STR.contextWindowTitle}</strong>
                          <span>{metrics().contextPercent!.toFixed(0)}%</span>
                        </div>
                        <span class="composer-context-bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, Math.max(0, metrics().contextPercent!))}%` }} />
                        </span>
                        <p class="composer-context-note">{STR.contextOccupied}</p>
                        <div class="composer-context-breakdown">
                          <strong>{STR.contextBreakdownPending}</strong>
                          <small>{STR.contextBreakdownNote}</small>
                        </div>
                        <button
                          type="button"
                          class="composer-context-compact"
                          disabled={props.running() || props.compactPhase?.() === "running"}
                          title={props.running() ? STR.contextCompactDisabledRunning : STR.contextCompactAction}
                          onClick={() => { props.onCompact?.(); setOpenMenu(null); }}
                        >
                          <IconArchive />{STR.contextCompactAction}
                        </button>
                      </div>
                    </Show>
                  </span>
                </Show>
                <Show when={metrics().cacheHitPercent != null}>
                  <span title="本轮 prompt cache 命中 token / 已报告的命中与未命中 token">
                    缓存命中 <strong>{metrics().cacheHitPercent!.toFixed(0)}%</strong>
                  </span>
                </Show>
                <For each={extras().slice(0, EXTRA_HUD_LIMIT)}>
                  {([key, value]) => (
                    <span title={`端点原生 usage 字段：${key}`}>
                      {key} <strong>{value}</strong>
                    </span>
                  )}
                </For>
                <Show when={extras().length > EXTRA_HUD_LIMIT}>
                  <span title={extras().map(([key, value]) => `${key} ${value}`).join(" · ")}>
                    +{extras().length - EXTRA_HUD_LIMIT}
                  </span>
                </Show>
              </div>
            );
          }}
        </Show>
      </div>
    </div>
  );
};
