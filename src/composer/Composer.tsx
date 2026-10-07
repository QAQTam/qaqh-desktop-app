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
import IconX from "~icons/lucide/x";
import { STR } from "../lib/strings";

export type SendBlockReason = "running" | "pending" | "offline" | "no-session" | null;

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
}> = (props) => {
  let textarea: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  const [openMenu, setOpenMenu] = createSignal<"profile" | "model" | "permission" | null>(null);
  const [profile, setProfile] = createSignal("本地模型");
  const [model, setModel] = createSignal("qaqh-visual-preview");
  const [permission, setPermission] = createSignal("workspace-write");
  const [files, setFiles] = createSignal<File[]>([]);
  const [submitting, setSubmitting] = createSignal(false);

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
        <Show when={files().length > 0}>
          <div class="composer-attachments" aria-label="待添加文件">
            <For each={files()}>{(file) => (
              <span class="composer-file-chip" title={file.name}>
                <IconPaperclip />
                <span>{file.name}</span>
                <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><IconX /></button>
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
            <Show when={props.showDesignControls}>
              <input
                ref={fileInput}
                class="composer-file-input"
                type="file"
                multiple
                onChange={(event) => {
                  const selected = [...(event.currentTarget.files ?? [])];
                  setFiles((current) => [...current, ...selected].slice(0, 4));
                  event.currentTarget.value = "";
                }}
              />
              <button type="button" class="composer-tool-button composer-add-file" aria-label="添加文件" title="添加文件" onClick={() => fileInput?.click()}>
                <IconPlus />
              </button>
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
              title={blockTitle()}
              disabled={submitting() || props.draft().trim() === "" || props.blocked() != null}
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
      </div>
    </div>
  );
};
