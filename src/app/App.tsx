/**
 * 应用壳:标签栏 + 会话视图 + 授权卡 + 输入区(spec §4 布局);
 * 全局快捷键(§5.3)与后台会话轮询。
 *
 * Tauri 桌面壳:
 *  - 使用系统标题栏与窗口控制,不让 WebView 内的 Ask 遮罩覆盖窗口按钮;
 *  - 外链经宿主 `open_external` 走系统浏览器(webview 内不导航外站);
 *  - daemon 兼容性失败(D1)渲染明确文案 + 「停止旧实例并连接」动作,
 *    不静默杀旧 daemon(可能正在跑 TUI 的 Turn);
 *  - 设置独立页(spec 第二阶段):Ctrl+, 开关,读写 daemon 全局配置
 *    (`config.load`/`config.save`/`profile.*` 经宿主白名单)。
 */
import { createEffect, createSignal, For, onSettled, Show, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconX from "~icons/lucide/x";
import { TabBar } from "../tabs/TabBar";
import { MessageSidebar } from "./MessageSidebar";
import { GlobalNav, type GlobalSection } from "./GlobalNav";
import { ToolsPage } from "./ToolsPage";
import {
  activeId,
  activeTab,
  activateTab,
  boot as bootTabs,
  bootError,
  closeTab,
  createSession,
  creating,
  draftOf,
  focusToken,
  openSession,
  pollSessions,
  setBootError,
  setDraftOf,
  sessionCatalog,
  tabs,
  type Tab,
} from "../tabs/store";
import { SessionView } from "../session/SessionView";
import { Composer, type SendBlockReason } from "../composer/Composer";
import { ApprovalStack } from "../approval/ApprovalCards";
import { SettingsView } from "../settings/SettingsView";
import {
  open as settingsOpen,
  requestClose as requestSettingsClose,
  toggleSettings,
} from "../settings/store";
import { STR } from "../lib/strings";
import { isTauriRuntime, listenHostDiagnostics, openExternalUrl, transport, tauriHost } from "../lib/transport";
import { applyConfigTheme } from "../lib/theme";
import { toast, ToastHost } from "../ui/toast";
import "../styles/app.css";

const inTauri = isTauriRuntime();

/** D1 兼容性失败详情(conn://incompatible);null = 正常。 */
const [hostIncompatible, setHostIncompatible] = createSignal<Record<string, unknown> | null>(null);
const [hostActionNote, setHostActionNote] = createSignal<string | null>(null);
const [section, setSection] = createSignal<"messages" | "tools">("messages");
const [emptyDraft, setEmptyDraft] = createSignal("");

/** 一键停止旧 daemon(不静默杀:Busy 时给动作文案)→ 重启标签引导。 */
async function stopStaleAndReconnect(): Promise<void> {
  const host = tauriHost(transport);
  if (host == null) return;
  setHostActionNote(STR.incompatibleStopping);
  try {
    const status = await host.stopStaleDaemon();
    if (status === "busy") {
      setHostActionNote(STR.incompatibleBusy);
      return;
    }
    setHostIncompatible(null);
    setHostActionNote(null);
    // 停止是异步收敛:稍候让 boot 重新走 discovery(旧记录已消失 → 拉起 sidecar)。
    setTimeout(() => void bootTabs().catch(() => setBootError(STR.bootFailed)), 800);
  } catch (error) {
    setHostActionNote(`${STR.hostError}:${String(error instanceof Error ? error.message : error)}`);
  }
}

const App: Component = () => {
  const [quitPrompt, setQuitPrompt] = createSignal<number | null | undefined>(undefined);
  const [quitConfirmStop, setQuitConfirmStop] = createSignal(false);
  const [quitBusy, setQuitBusy] = createSignal(false);
  const [quitError, setQuitError] = createSignal<string | null>(null);
  let quitCancelButton: HTMLButtonElement | undefined;

  onSettled(() => {
    void bootTabs().catch((error: unknown) => {
      // boot() 只对「没有可用会话」写 bootError;bootstrap/网络异常在此兜底,
      // 给出可执行的下一步(§16 错误文案),而不是静默空屏。
      console.error(error);
      setBootError(STR.bootFailed);
    });
    // 后台标签状态点(§5.2):轮询 sessions 列表(turn_count/running/title)。
    const poll = setInterval(() => void pollSessions(), 15_000);
    const onFocus = (): void => {
      void pollSessions();
      const tab = activeTab();
      // reconnecting 也重试:状态可能因事件竞态/退避中卡在中间态,
      // 聚焦触发宿主重建流(activate_timeline 会发新 open 事件自愈)。
      if (tab != null && tab.store.connection[0]() !== "connected") tab.store.retry();
    };
    window.addEventListener("focus", onFocus);

    // 启动即取一次主题配置(失败静默:跟随系统),避免「设置过深色但重开是浅色」。
    void transport
      .rpc<{ theme: string | null }>("config.load")
      .then((config) => applyConfigTheme(config.theme, false))
      .catch(() => {});

    // Tauri:外链一律走系统浏览器;宿主诊断事件(兼容性失败/宿主错误)。
    let unlistenHost: (() => void) | null = null;
    let unlistenQuit: UnlistenFn | null = null;
    let onClickCleanup: (() => void) | null = null;
    if (inTauri) {
      void listen<void>("app://quit-requested", () => {
        setQuitConfirmStop(false);
        setQuitError(null);
        void transport.rpc<Array<{ state?: string }>>("session.activity")
          .then((activities) => {
            const activeCount = activities.filter((item) =>
              item.state === "starting" || item.state === "working" || item.state === "waiting_user",
            ).length;
            setQuitPrompt(activeCount);
            requestAnimationFrame(() => quitCancelButton?.focus());
          })
          .catch(() => {
            setQuitPrompt(null);
            requestAnimationFrame(() => quitCancelButton?.focus());
          });
      }).then((unlisten) => {
        unlistenQuit = unlisten;
      });

      const onClick = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        const anchor = target?.closest("a[href]");
        const href = anchor?.getAttribute("href") ?? "";
        if (!/^https?:\/\//i.test(href)) return;
        event.preventDefault();
        void openExternalUrl(href);
      };
      document.addEventListener("click", onClick, true);
      onClickCleanup = () => document.removeEventListener("click", onClick);
      void listenHostDiagnostics({
        onIncompatible: (details) => {
          setHostActionNote(null);
          setHostIncompatible(details);
        },
        onHostError: (message) => setBootError(message),
      }).then((unlisten) => {
        unlistenHost = unlisten;
      });
    }

    // 全局快捷键(§5.3)。
    const onKey = (event: KeyboardEvent): void => {
      if (quitPrompt() !== undefined && event.key === "Escape") {
        event.preventDefault();
        setQuitPrompt(undefined);
        setQuitConfirmStop(false);
        return;
      }
      // 浮层开着时快捷键归浮层:Ctrl+T/W/Tab/1-9 不该在遮罩背后建会话、切标签。
      if (settingsOpen()) {
        const modKey = event.ctrlKey || event.metaKey;
        if (event.key === "Escape" || (modKey && event.key === ",")) {
          event.preventDefault();
          requestSettingsClose();
        }
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === ",") {
        event.preventDefault();
        toggleSettings();
        return;
      }
      if (!mod) return;
      if (event.key === "t" || event.key === "T") {
        event.preventDefault();
        setSection("messages");
        void createSession();
      } else if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        setSection("messages");
        const id = activeId();
        if (id != null) {
          void closeTab(id);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".tab.active")?.focus());
        }
      } else if (event.key === "Tab") {
        event.preventDefault();
        const list = tabs();
        if (list.length < 2) return;
        setSection("messages");
        const index = list.findIndex((tab) => tab.id === activeId());
        const next = event.shiftKey
          ? list[(index - 1 + list.length) % list.length]!
          : list[(index + 1) % list.length]!;
        void activateTab(next);
      } else if (/^[1-9]$/.test(event.key)) {
        const list = tabs();
        const target = list[Number(event.key) - 1];
        if (target != null) {
          event.preventDefault();
          setSection("messages");
          void activateTab(target);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // onSettled 作用域禁止 onCleanup(rc.13:CLEANUP_IN_FORBIDDEN_SCOPE)——
    // 返回清理函数,由 owner disposal 调用。
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
      onClickCleanup?.();
      unlistenHost?.();
      unlistenQuit?.();
    };
  });

  const finishExit = async (stopDaemon: boolean, stopActiveWork = false): Promise<void> => {
    if (quitBusy()) return;
    setQuitBusy(true);
    setQuitError(null);
    try {
      await invoke("exit_app", { stopDaemon, stopActiveWork });
    } catch (cause) {
      setQuitError(cause instanceof Error ? cause.message : String(cause));
      setQuitBusy(false);
    }
  };

  const active = (): ReturnType<typeof activeTab> => activeTab();

  const blockedReason = (tab: Tab | null = active()): SendBlockReason => {
    if (tab == null) return "offline";
    if (tab.store.connection[0]() !== "connected") return "offline";
    if (tab.store.pending[0]().length > 0) return "pending";
    // 运行态读 reducer 维护的计数:遍历 turns 会让输入区订阅每一个回合,
    // 于是每帧流式写入都重算一次发送按钮(高吞吐下的卡顿放大器)。
    if (tab.store.state[0].runningTurns > 0 || tab.store.activity[0]() === "working") return "running";
    return null;
  };

  const runningNow = (tab: Tab | null = active()): boolean => {
    if (tab == null) return false;
    return tab.store.state[0].runningTurns > 0 || tab.store.activity[0]() === "working";
  };

  const connectionNotice = (): string | null => {
    const error = bootError();
    if (error != null) return error;
    const tab = activeTab();
    if (tab == null) return null;
    const state = tab.store.connection[0]();
    if (state === "reconnecting") return STR.reconnecting;
    return state === "connected" ? null : STR.disconnected;
  };

  createEffect(
    () => [activeTab(), emptyDraft()] as const,
    ([tab, pendingDraft]) => {
      if (tab != null && pendingDraft !== "") {
        setDraftOf(tab.seed, pendingDraft);
        setEmptyDraft("");
      }
    },
  );

  const retryConnection = (): void => {
    setBootError(null);
    const tab = activeTab();
    if (tab != null) {
      tab.store.retry();
      return;
    }
    void bootTabs().catch((error: unknown) => {
      setBootError(String(error instanceof Error ? error.message : error));
    });
  };

  const navigateSection = (next: GlobalSection): void => {
    if (next === "settings") {
      if (settingsOpen()) requestSettingsClose();
      else toggleSettings();
      return;
    }
    if (settingsOpen()) requestSettingsClose();
    setSection(next);
  };

  const send = async (tab: Tab, text: string): Promise<void> => {
    try {
      await tab.store.sendMessage(text);
      // A slow acknowledgement must not erase text typed for the next message.
      if (draftOf(tab.seed) === text) setDraftOf(tab.seed, "");
    } catch (error) {
      toast(`${STR.sendFailed}：${String(error instanceof Error ? error.message : error)}`, "err");
    }
  };

  return (
    <div id="app" class={{ "tauri-shell": inTauri, "has-topbar": !inTauri || settingsOpen() || section() !== "messages" }}>
      <Show when={!inTauri || settingsOpen() || section() !== "messages"}>
        <header id="top">
          <Show when={settingsOpen() || section() !== "messages"}>
            <button type="button" class="titlebar-back" aria-label="返回消息" title="返回消息" onClick={() => navigateSection("messages")}>
              <IconArrowLeft />
            </button>
          </Show>
          <Show when={!inTauri}><div class="titlebar-brand">QAQH</div></Show>
          <div class="titlebar-session-title">{settingsOpen() ? "设置" : section() === "tools" ? "工具" : "消息"}</div>
        </header>
      </Show>
      <GlobalNav
        active={settingsOpen() ? "settings" : section()}
        onNavigate={navigateSection}
      />
      <div class={settingsOpen() ? "workspace workspace-settings" : section() === "messages" ? "workspace workspace-messages" : "workspace"}>
        <Show when={settingsOpen()} fallback={
          <>
        <Show when={section() === "messages"}>
          <MessageSidebar
            sessions={sessionCatalog()}
            activeSeed={activeTab()?.seed ?? null}
            onSelect={(seed) => { setSection("messages"); void openSession(seed); }}
          />
        </Show>
        <div class="workspace-content">
        <div class="session-tabs-region">
        <TabBar
          tabs={tabs()}
          activeId={activeId()}
          creating={creating()}
          canCreate={hostIncompatible() == null}
          onSelect={(id) => {
            setSection("messages");
            const tab = tabs().find((item) => item.id === id);
            if (tab != null) void activateTab(tab);
          }}
          onClose={(id) => void closeTab(id)}
          onCreate={() => {
            setSection("messages");
            void createSession();
          }}
        />
        </div>
        <main id="main">
          <Show when={hostIncompatible() != null}>
            <div class="host-banner" role="alert">
              <span>
                {STR.incompatibleDaemon(
                  typeof hostIncompatible()!.detail === "string" ? (hostIncompatible()!.detail as string) : "版本/协议不匹配",
                )}
              </span>
              <Show when={hostActionNote() != null}>
                <span class="host-banner-note">{hostActionNote()}</span>
              </Show>
              <span class="host-banner-actions">
                <button type="button" class="ghost-mini" onClick={() => void stopStaleAndReconnect()}>
                  {STR.incompatibleStopAndConnect}
                </button>
                <button type="button" class="ghost-mini" onClick={() => void bootTabs()}>
                  {STR.retry}
                </button>
              </span>
            </div>
          </Show>
          <Show when={section() === "messages"}>
            <Show when={tabs().length > 0} fallback={
              <div class="session-column">
                <div id="messages" class="messages-empty">
                  <div class="messages-empty-copy">
                    <strong>QAQH</strong>
                    <p>{STR.emptyMessages}</p>
                    <button type="button" class="primary-mini button-primary" disabled={creating() || hostIncompatible() != null} onClick={() => void createSession()}>
                      {creating() ? STR.creatingSession : STR.newTab}
                    </button>
                  </div>
                </div>
                <Composer
                  draft={() => emptyDraft()}
                  onDraft={setEmptyDraft}
                  blocked={() => "no-session"}
                  running={() => false}
                  onSend={() => {}}
                  onStop={() => {}}
                  focusToken={0}
                  autoFocus={false}
                  placeholder={STR.emptyComposer}
                />
              </div>
            }>
            <For each={tabs()}>
              {(tab) => (
                // 非活动标签卸载 DOM(§5.3),store 数据保留。
                <Show when={tab.id === activeId()}>
                  <div
                    class="session-column"
                    id={`panel-${tab.id}`}
                    role="tabpanel"
                    aria-labelledby={`tab-${tab.id}`}
                  >
                    <SessionView tab={tab} />
                    <Show when={tab.store.pending[0]().length > 0}>
                      <ApprovalStack
                        pending={tab.store.pending[0]()}
                        respond={(challengeId, decision, payload) => tab.store.respondApproval(challengeId, decision, payload)}
                      />
                    </Show>
                    <Composer
                      draft={() => draftOf(tab.seed)}
                      onDraft={(value) => setDraftOf(tab.seed, value)}
                      blocked={() => blockedReason(tab)}
                      running={() => runningNow(tab)}
                      onSend={(text) => send(tab, text)}
                      onStop={() => void tab.store.cancelTurn().catch(() => {})}
                      focusToken={focusToken()}
                    />
                  </div>
                </Show>
              )}
            </For>
            </Show>
          </Show>
          {/* The session switcher remains available on the Tools page, so keep its
              selected tab's controlled panel in the accessibility tree contract. */}
          <Show when={section() === "tools" && activeTab() != null}>
            <div
              class="session-column"
              id={`panel-${activeTab()!.id}`}
              role="tabpanel"
              aria-labelledby={`tab-${activeTab()!.id}`}
              hidden
            />
          </Show>
          <Show when={section() === "tools"}><ToolsPage /></Show>
        </main>
        </div>
          </>
        }>
          <SettingsView />
        </Show>
      </div>
      <Show when={connectionNotice() != null}>
        <div class="connection-notice" role="status" aria-live="polite">
          <span>{connectionNotice()}</span>
          <button type="button" class="ghost-mini" onClick={retryConnection}>{STR.retry}</button>
        </div>
      </Show>
      <Show when={quitPrompt() !== undefined}>
        <div class="quit-overlay" role="presentation">
          <section class="quit-dialog" role="dialog" aria-modal="true" aria-labelledby="quit-dialog-title">
            <header class="quit-dialog-head">
              <strong id="quit-dialog-title">退出 QAQH</strong>
              <button type="button" class="icon-btn" aria-label="取消退出" onClick={() => { setQuitPrompt(undefined); setQuitConfirmStop(false); }} disabled={quitBusy()}>
                <IconX />
              </button>
            </header>
            <div class="quit-dialog-body">
              <Show when={quitPrompt() === null} fallback={
                <Show when={(quitPrompt() ?? 0) > 0} fallback={
                  <>
                    <p>当前没有运行中或等待处理的会话。</p>
                    <p class="quit-dialog-note">停止 daemon 会断开其他客户端；也可以退出 QAQH 并让服务留在后台。</p>
                  </>
                }>
                  <p>有 <b>{quitPrompt()}</b> 个会话正在运行或等待处理。</p>
                  <p class="quit-dialog-note">退出界面会让后台任务继续运行。停止 daemon 会中断所有客户端连接中的会话。</p>
                </Show>
              }>
                <p>暂时无法确认 daemon 的活动状态。为保护后台任务，建议退出界面并让 daemon 继续运行。</p>
                <p class="quit-dialog-note">停止服务选项会保持禁用，直到活动状态可查询。</p>
              </Show>
              <Show when={quitError() != null}><p class="quit-dialog-error" role="alert">{quitError()}</p></Show>
              <Show when={quitConfirmStop()}>
                <div class="quit-stop-confirm" role="alert">
                  <b>确认停止所有后台任务？</b>
                  <p>这会优雅关闭共享 daemon，并中断运行中或等待授权的会话。其他客户端也会断开。</p>
                </div>
              </Show>
            </div>
            <footer class="quit-dialog-actions">
              <Show when={quitConfirmStop()} fallback={
                <>
                  <button ref={quitCancelButton} type="button" class="button-secondary" onClick={() => { setQuitPrompt(undefined); setQuitConfirmStop(false); }} disabled={quitBusy()}>取消</button>
                  <button type="button" class="button-secondary" onClick={() => void finishExit(false)} disabled={quitBusy()}>
                    退出并保留后台任务
                  </button>
                  <Show when={quitPrompt() !== null}>
                    <button type="button" class="button-danger" onClick={() => {
                      if ((quitPrompt() ?? 0) > 0) setQuitConfirmStop(true);
                      else void finishExit(true);
                    }} disabled={quitBusy()}>
                      {(quitPrompt() ?? 0) > 0 ? "停止任务并退出…" : "退出并停止空闲服务"}
                    </button>
                  </Show>
                </>
              }>
                <button ref={quitCancelButton} type="button" class="button-secondary" onClick={() => setQuitConfirmStop(false)} disabled={quitBusy()}>返回</button>
                <button type="button" class="button-danger" onClick={() => void finishExit(true, true)} disabled={quitBusy()}>
                  {quitBusy() ? "正在停止…" : "确认停止并退出"}
                </button>
              </Show>
            </footer>
          </section>
        </div>
      </Show>
      <ToastHost />
    </div>
  );
};

export default App;
