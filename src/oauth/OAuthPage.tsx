/**
 * 「接入」页 —— GlobalNav 的独立页。
 *
 * ## 这一页在做什么
 *
 * **前端代管多 provider**：名册在 `./providers`，每家的状态（模型/端点/协议）在
 * `./provider-state`，模型特判（档位/窗口/展示名）在 `../models/specs`。后端只承担
 * 一件小事：把**当前生效那家**的字段收进配置（合并补丁）。凭据始终留在 daemon。
 *
 * 为什么这么切：后端短期内没有 per-provider 的结构可挂，而单一的全局 `model`
 * 装不下两份状态——**切走之前先快照**（`captureProviderState`）才谈得上切回来。
 *
 * ## 两条硬约束
 *
 * 1. 本页只写「provider 相关的字段」（credential/wire/baseUrl/model/contextLength），
 *    绝不整包写回：设置页可能正有未保存草稿，整包会把它一起提交。
 * 2. 授权 URL 交给**系统浏览器**打开；daemon 不 spawn 进程、也不内嵌 webview。
 */
import { createSignal, For, Match, onCleanup, onSettled, Show, Switch, type Component } from "solid-js";
import IconChevronLeft from "~icons/lucide/chevron-left";

import type { ConfigDto } from "../api/qaqh/ConfigDto";
import { DsAccountCard } from "../dsaccount/components/AccountCard";
import type { DsAccountStatus } from "../dsaccount/state";
import {
  defaultDsSignInDeps,
  dsaccountBalance,
  dsaccountSignInCancel,
  dsaccountSignOut,
  dsaccountStatus,
  runDeepSeekSignIn,
  type DsBalance,
} from "../lib/dsaccount";
import {
  openExternal,
  runSignInFlow,
  siwcSignInCancel,
  siwcSignInStart,
  siwcSignInStatus,
  siwcSignOut,
  siwcStatus,
} from "../lib/siwc";
import { transport } from "../lib/transport";
import { isTauriRuntime } from "../lib/transport/backend";
import { modelSpec } from "../models/specs";
import { siwcApiBase, siwcPlanBadgeVisible, type SiwcSessionStatus } from "../siwc/brand";
import { SiwcConnectionCard } from "../siwc/components/ConnectionCard";
import { SiwcFirstRunNotice } from "../siwc/components/FirstRunNotice";
import { toast } from "../ui/toast";
import { isOauthMode } from "./mode";
import {
  activeProviderId,
  captureProviderState,
  loadState,
  rememberState,
  saveState,
  switchFields,
  type ProviderStateMap,
} from "./provider-state";
import {
  BYOK_PROVIDER_ID,
  DSACCOUNT_PROVIDER_ID,
  PLAN_PROVIDER_ID,
  PROVIDERS,
  providerById,
  type ProviderEntry,
} from "./providers";

/** 首次成功启用套餐后的欢迎卡只出现一次，看过的标记留在本机。 */
const FIRST_RUN_KEY = "siwc.firstRunSeen";

function firstRunSeen(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    return true;
  }
}

function markFirstRunSeen(): void {
  try {
    window.localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch {
    // 忽略：下次仍会弹一次。
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type QuotaRow = { label: string; value: string; tone?: "ok" | "muted" };

/**
 * 一张 provider 卡：正面是「谁」，点击翻面到「怎么连 / 连上后怎样」。
 * 卡片骨架与流程解耦——`Switch` 按 `kind` 分支，友商接入时加一个分支即可。
 */
const ProviderCard: Component<{
  entry: ProviderEntry;
  active: boolean;
  /** 当前生效的模型名（用于展示；来自 daemon 配置，不是本卡的本地状态）。 */
  model: string | null;
  status: SiwcSessionStatus | null;
  busy: boolean;
  onSwitch: () => void;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  onOpenUsage: (url: string) => void;
}> = (props) => {
  const [flipped, setFlipped] = createSignal(false);
  const connected = (): boolean => props.status?.status === "connected";

  const stateLabel = (): string => {
    if (props.active) return props.busy ? "切换中…" : "使用中";
    return "未启用";
  };

  /** 模型展示名 + 是否收录（未收录要说出来，不能让用户以为我们认得它）。 */
  const modelLabel = (): string | null => {
    if (props.model == null || props.model === "") return null;
    const { spec, known } = modelSpec("plan", props.model);
    const name = spec.displayName ?? props.model;
    const base = name === props.model ? name : `${name}（${props.model}）`;
    return known ? base : `${base} · 未收录`;
  };

  /** 只显示用户看得懂、且**不撒谎**的几行。 */
  const quotaRows = (): QuotaRow[] => {
    const current = props.status;
    const rows: QuotaRow[] = [];
    const account = current?.email ?? current?.name ?? current?.label;
    if (account != null && account !== "") rows.push({ label: "账户", value: account });
    if (current != null) {
      rows.push({
        label: "套餐用量",
        value: siwcPlanBadgeVisible(current)
          ? "已启用"
          : connected()
            ? "未启用（仅登录，请求不走套餐）"
            : "未连接",
        tone: siwcPlanBadgeVisible(current) ? "ok" : "muted",
      });
    }
    const model = modelLabel();
    if (model != null) rows.push({ label: "模型", value: model });
    const apiBase = siwcApiBase(current);
    if (apiBase != null) rows.push({ label: "端点", value: apiBase });
    return rows;
  };

  return (
    <article
      class={`oauth-card${flipped() ? " is-flipped" : ""}${props.active ? " is-active" : ""}`}
      data-provider={props.entry.id}
    >
      <div class="oauth-card__inner">
        <button
          type="button"
          class="oauth-card__face oauth-card__front"
          aria-expanded={flipped() ? "true" : "false"}
          onClick={() => setFlipped(true)}
        >
          <span class="oauth-card__brand">{props.entry.name}</span>
          <span class="oauth-card__state">{stateLabel()}</span>
          <span class="oauth-card__blurb">{props.entry.blurb}</span>
          <span class="oauth-card__hint">
            {props.entry.kind === "plan" ? "点击卡片：使用 ChatGPT 登录" : "点击卡片：查看怎么切回来"}
          </span>
        </button>

        <div class="oauth-card__face oauth-card__back">
          <button
            type="button"
            class="ghost-mini oauth-card__back-btn"
            onClick={() => setFlipped(false)}
          >
            <IconChevronLeft />
            <span>返回</span>
          </button>

          <Switch>
            <Match when={props.entry.kind === "plan"}>
              <SiwcConnectionCard
                status={props.status}
                busy={props.busy}
                onSignIn={() => props.onSignIn()}
                onCancel={() => props.onCancel()}
                onSignOut={() => props.onSignOut()}
                onOpenUsage={(url) => props.onOpenUsage(url)}
              />
              <Show when={quotaRows().length > 0}>
                <dl class="oauth-quota">
                  <For each={quotaRows()}>
                    {(row) => (
                      <>
                        <dt>{row.label}</dt>
                        <dd
                          class={
                            row.tone === "muted" ? "is-muted" : row.tone === "ok" ? "is-ok" : undefined
                          }
                        >
                          {row.value}
                        </dd>
                      </>
                    )}
                  </For>
                </dl>
              </Show>
            </Match>
            <Match when={props.entry.kind === "account"}>
              <p class="oauth-card__blurb">
                DeepSeek 账号的登录、余额与赠金在页面下方的「DeepSeek 账号」区。切到这一家时，
                只写它需要的三个字段（凭据 / openai 协议 / 官方端点）——端点换成别的地址会被
                后端在保存期直接拒绝。
              </p>
            </Match>
            <Match when={props.entry.kind === "byok"}>
              <p class="oauth-card__blurb">
                自带 key 的模型与端点由你在设置页维护；切换回来时，我们把你**切走之前**
                那套（模型 / 端点 / 协议）写回配置。
              </p>
            </Match>
          </Switch>

          <Show when={!props.active}>
            <button
              type="button"
              class="ghost-mini"
              disabled={props.busy}
              onClick={() => props.onSwitch()}
            >
              切到这一家
            </button>
          </Show>
        </div>
      </div>
    </article>
  );
};

export const OAuthPage: Component = () => {
  const available = isTauriRuntime();
  /** 已保存事实（`config.load` 的整份读模型）：切换要快照它，所以留整份。 */
  const [config, setConfig] = createSignal<ConfigDto | null>(null);
  /** 每 provider 记住的状态（前端代管）。 */
  const [states, setStates] = createSignal<ProviderStateMap>(loadState());
  const [status, setStatus] = createSignal<SiwcSessionStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [flowId, setFlowId] = createSignal<string | null>(null);
  const [firstRun, setFirstRun] = createSignal(false);
  /** DeepSeek 账号态与余额（余额只在已登录时读）。 */
  const [dsStatus, setDsStatus] = createSignal<DsAccountStatus | null>(null);
  const [dsBalance, setDsBalance] = createSignal<DsBalance | null>(null);
  const [dsBusy, setDsBusy] = createSignal(false);
  const [dsAttempt, setDsAttempt] = createSignal<string | null>(null);

  const oauthOn = (): boolean => isOauthMode(config());
  const activeId = (): string | null => {
    const current = config();
    return current == null ? null : activeProviderId(current);
  };

  const loadConfig = async (): Promise<void> => {
    if (!available) return;
    try {
      setConfig(await transport.rpc<ConfigDto>("config.load"));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const refreshStatus = async (): Promise<void> => {
    if (!available) return;
    try {
      setStatus(await siwcStatus());
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  /** 读 DeepSeek 账号态；已登录才去读余额（未登录时后端给 not_signed_in）。 */
  const refreshDs = async (): Promise<void> => {
    if (!available) return;
    try {
      const next = await dsaccountStatus();
      setDsStatus(next);
      setDsBalance(next.signedIn ? await dsaccountBalance() : null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  onSettled(() => {
    if (!available) return;
    void loadConfig();
    void refreshStatus();
    void refreshDs();
    const timer = window.setInterval(() => {
      if (flowId() == null) void refreshStatus();
      // 登录进行中由流程驱动自己轮询，页面这边不掺和（免得两个轮询抢状态）。
      if (dsAttempt() == null) void refreshDs();
    }, 10_000);
    onCleanup(() => window.clearInterval(timer));
  });

  /**
   * 切到某一家。三步走：
   * 1. **先把当前这套抓下来**存进它自己的槽位（不做这步，切回来就还原不了）；
   * 2. 用目标那家的状态算出要写的字段（合并补丁，只发这几个键）；
   * 3. 落盘后把目标那家的模型名也记下来，并重新读配置（草稿不是事实）。
   */
  const switchTo = async (target: ProviderEntry): Promise<void> => {
    const current = config();
    if (current == null || busy()) return;
    setBusy(true);
    setError(null);
    try {
      let next = rememberState(states(), activeProviderId(current), captureProviderState(current));
      // 官方端点只从后端取：ChatGPT 那条来自 `siwc.status.apiBase`，DeepSeek 账号
      // 这条来自 `dsaccount.status.inferenceOrigin`。前端**不拼** URL。
      const apiBase =
        target.kind === "account"
          ? (dsStatus()?.inferenceOrigin ?? null)
          : siwcApiBase(status());
      const fields = switchFields(target, next, apiBase);
      await transport.rpc("config.save", fields);
      const model = fields.model;
      if (typeof model === "string" && model !== "") {
        next = rememberState(next, target.id, { model });
      }
      setStates(next);
      saveState(next);
      await loadConfig();
      toast(
        target.kind === "plan"
          ? "已切换到 ChatGPT 套餐"
          : target.kind === "account"
            ? "已切换到 DeepSeek 账号"
            : "已切回自带 API key",
        "ok",
        { dedupeKey: "provider-switch" },
      );
    } catch (cause) {
      setError(messageOf(cause));
      toast(`切换失败：${messageOf(cause)}`, "err", { dedupeKey: "provider-switch-error" });
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await runSignInFlow(
        { onStarted: (id) => setFlowId(id) },
        {
          start: siwcSignInStart,
          status: siwcSignInStatus,
          cancel: siwcSignInCancel,
          openExternal,
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
      );
      if (outcome.kind === "completed") {
        await refreshStatus();
        if (status()?.sharing === true && !firstRunSeen()) setFirstRun(true);
        toast("ChatGPT 账户已连接", "info", { dedupeKey: "siwc-connected" });
      } else if (outcome.kind === "failed") {
        setError(outcome.message);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setFlowId(null);
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    const id = flowId();
    if (id == null) return;
    try {
      await siwcSignInCancel(id);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await siwcSignOut();
      await refreshStatus();
      if (!result.revoked) {
        toast("已在本机登出；远端撤销未确认，可在 ChatGPT 设置里断开本应用", "info", {
          dedupeKey: "siwc-revoke-unconfirmed",
        });
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleOauth = (next: boolean): void => {
    const target = providerById(next ? PLAN_PROVIDER_ID : BYOK_PROVIDER_ID);
    if (target != null) void switchTo(target);
  };

  const dsSignIn = async (): Promise<void> => {
    setDsBusy(true);
    setError(null);
    try {
      const outcome = await runDeepSeekSignIn(
        { onStarted: (attemptId) => setDsAttempt(attemptId) },
        defaultDsSignInDeps,
      );
      if (outcome.kind === "completed") {
        await refreshDs();
        toast("DeepSeek 账号已连接", "info", { dedupeKey: "dsaccount-connected" });
      } else if (outcome.kind === "failed") {
        setError(outcome.message);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDsAttempt(null);
      setDsBusy(false);
    }
  };

  const dsCancel = async (): Promise<void> => {
    const attemptId = dsAttempt();
    if (attemptId == null) return;
    try {
      await dsaccountSignInCancel(attemptId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const dsSignOut = async (): Promise<void> => {
    setDsBusy(true);
    try {
      await dsaccountSignOut();
      setDsBalance(null);
      await refreshDs();
      toast("已断开 DeepSeek 账号", "info", { dedupeKey: "dsaccount-signout" });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDsBusy(false);
    }
  };

  return (
    <div class="oauth-page">
      <header class="oauth-page-head">
        <h1>接入</h1>
        <p>
          用你自己的账号额度完成推理，无需配置 API key。凭据保存在本机（加密），
          不会出到前端；打开开关后，设置页的「模型与端点(BYOK)」由本页接管。
        </p>
      </header>

      <Show
        when={available}
        fallback={<p class="field-hint">浏览器预览下不可用：请在桌面壳里打开本页面。</p>}
      >
        <section class="oauth-section">
          <div class={`oauth-mode${oauthOn() ? " is-on" : ""}`}>
            <label class="oauth-pill">
              <input
                type="checkbox"
                checked={oauthOn()}
                disabled={busy()}
                onChange={(event) => toggleOauth(event.currentTarget.checked)}
              />
              <span class="oauth-pill__track" aria-hidden="true">
                <span class="oauth-pill__thumb" />
              </span>
              <span class="oauth-pill__text">
                <span class="oauth-pill__title">OAuth 模式</span>
                <span class="oauth-pill__hint">
                  {oauthOn()
                    ? "已开启：模型与端点(BYOK) 由本模式接管（那几个字段在设置页置灰）"
                    : "关闭时按下面的自带 key 那家走"}
                </span>
              </span>
            </label>
            <p class="oauth-mode__note">
              开关即生效。切换时我们会先记下你当前那套配置，切回来再写回——不会丢。
            </p>
          </div>
        </section>

        <section class="oauth-section">
          <h2 class="oauth-section-title">服务商</h2>
          <For each={PROVIDERS}>
            {(entry) => (
              <ProviderCard
                entry={entry}
                active={activeId() === entry.id}
                model={config()?.model ?? null}
                status={status()}
                busy={busy()}
                onSwitch={() => void switchTo(entry)}
                onSignIn={() => void signIn()}
                onCancel={() => void cancel()}
                onSignOut={() => void signOut()}
                onOpenUsage={(url) => void openExternal(url)}
              />
            )}
          </For>
        </section>

        <section class="oauth-section">
          <h2 class="oauth-section-title">DeepSeek 账号</h2>
          <DsAccountCard
            status={dsStatus()}
            balance={dsBalance()}
            busy={dsBusy()}
            onSignIn={() => void dsSignIn()}
            onCancel={() => void dsCancel()}
            onSignOut={() => void dsSignOut()}
            onOpenLink={(url) => void openExternal(url)}
          />
          <Show when={activeId() !== DSACCOUNT_PROVIDER_ID}>
            <button
              type="button"
              class="ghost-mini"
              disabled={busy()}
              onClick={() => {
                const entry = providerById(DSACCOUNT_PROVIDER_ID);
                if (entry != null) void switchTo(entry);
              }}
            >
              用本机 DeepSeek 账号余额
            </button>
          </Show>
        </section>

        <Show when={error()}>
          {(message) => <p class="field-hint is-error oauth-page-error">{message()}</p>}
        </Show>
      </Show>

      <SiwcFirstRunNotice
        open={firstRun()}
        onDismiss={() => {
          markFirstRunSeen();
          setFirstRun(false);
        }}
      />
    </div>
  );
};
