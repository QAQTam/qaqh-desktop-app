/**
 * 强度卡（对齐 Codex 桌面端那张）：档位名 + 档位图标 + `模型 ›` 行 + 可拖的分段
 * 轨道 + 重置，触发器是控制条上的一个 chip。
 *
 * **全局可用**：它读写的是 daemon 全局配置里的 `reasoningEffort` / `model`，与
 * 凭据来源无关；可用档位由模型特判（`../models/specs`）决定，缺省是全阶梯
 * （low→medium→high→xhigh→ultra），后端再按端点 compat 钳制。
 *
 * 复刻上的三处取舍，都写在明处：
 * - **档位图标**按 Codex 的"几档共用图标"来分（低档闪电 / 高档脑 / Ultra 星），
 *   但用的是我们自己图标集里语义最近的，不是抄它的 SVG；
 * - **配色只分两级**（普通 = 绿，Ultra = 紫），与截图一致；颜色不承担具体档位，
 *   档位名已经说清了；
 * - **轨道**是自定义可拖的（pointer + 键盘 ←/→），不是原生 range：截图里那根
 *   带刻度点的轨道原生控件做不出来。
 */
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch, type Component } from "solid-js";
import IconBrain from "~icons/lucide/brain";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconRotateCcw from "~icons/lucide/rotate-ccw";
import IconSparkles from "~icons/lucide/sparkles";
import IconZap from "~icons/lucide/zap";

import { modelSpec, type ReasoningTier } from "../models/specs";
import { effortFillPercent, stepTier, tierIndexForPointer, tierTone } from "./effort-track";
import {
  availableTiers,
  catalogModels,
  configBusy,
  configError,
  currentEffort,
  currentModel,
  defaultTier,
  loadCatalog,
  oauthActive,
  refreshConfig,
  setEffort,
  setModel,
  specBucket,
} from "./model-config";

/** 档位中文名：与 Codex 的中文词条一致（轻度 / 中 / 高 / 极高 / Ultra）。 */
const TIER_LABEL: Record<ReasoningTier, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "Ultra",
};

export const EffortCard: Component<{
  open: boolean;
  onToggle: () => void;
}> = (props) => {
  const [pickingModel, setPickingModel] = createSignal(false);
  const [customModel, setCustomModel] = createSignal("");
  const [dragging, setDragging] = createSignal(false);
  /** 拖动中的**本地预览值**：不落盘，松手才写一次。 */
  const [pending, setPending] = createSignal<ReasoningTier | null>(null);
  let track: HTMLDivElement | undefined;

  // 打开时读一次配置；套餐模式再拉一次模型目录（账户级的，BYOK 无关）。
  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      setPickingModel(false);
      setCustomModel(currentModel());
      void refreshConfig();
      void loadCatalog();
    },
  );

  onCleanup(() => setDragging(false));

  const tiers = (): readonly ReasoningTier[] => availableTiers();

  /** 当前档：拖动中优先显示预览值；配置里的值可能不在该模型的可选集合里（换过模型/别的端改过）→ 落到首档。 */
  const tier = (): ReasoningTier => {
    const preview = pending();
    if (preview != null) return preview;
    const allowed = tiers();
    return allowed.find((t) => t === currentEffort()) ?? allowed[0] ?? "medium";
  };

  const index = (): number => Math.max(0, tiers().indexOf(tier()));
  const fill = (): number => effortFillPercent(index(), tiers().length);

  const modelLabel = (): string => {
    const model = currentModel();
    if (model === "") return "未设置模型";
    const { spec, known } = modelSpec(specBucket(), model);
    const name = spec.displayName ?? model;
    const base = name === model ? name : `${name}（${model}）`;
    return known ? base : `${base} · 未收录`;
  };

  /**
   * 指针位置 → 档位。拖动期间**只改本地预览**：一次拖拽可能跨好几档，每跨一档
   * 就发一次 `config.save` 会连发多次落盘 + 热载广播（而且中途的档位用户根本没
   * 打算用）。松手时 `commitPending` 写一次。
   */
  const applyPointer = (clientX: number): void => {
    const node = track;
    if (node == null) return;
    const rect = node.getBoundingClientRect();
    const next = tiers()[tierIndexForPointer(clientX, rect, tiers().length)];
    if (next != null) setPending(next);
  };

  /** 松手落盘。写成功（`setEffort` 内含重新读配置）之后再清预览，避免闪回旧值。 */
  const commitPending = async (): Promise<void> => {
    const next = pending();
    if (next == null) return;
    await setEffort(next);
    setPending(null);
  };

  return (
    <div class="composer-control-wrap">
      <button
        type="button"
        class="composer-tool-button effort-trigger"
        aria-expanded={props.open ? "true" : "false"}
        title="推理强度与模型"
        onClick={() => props.onToggle()}
      >
        <span class={`effort-tone-${tierTone(tier())}`}>{TIER_LABEL[tier()]}</span>
        <IconChevronDown />
      </button>

      <Show when={props.open}>
        <div class="composer-menu effort-card" role="dialog" aria-label="推理强度与模型">
          <div class="effort-card__head">
            <span class="effort-card__tier-icon" aria-hidden="true">
              <Switch>
                <Match when={tier() === "ultra"}>
                  <IconSparkles />
                </Match>
                <Match when={tier() === "low" || tier() === "medium"}>
                  <IconZap />
                </Match>
                <Match when={true}>
                  <IconBrain />
                </Match>
              </Switch>
            </span>
            <strong class={`effort-card__tier effort-tone-${tierTone(tier())}`}>
              {TIER_LABEL[tier()]}
            </strong>
            <button
              type="button"
              class="icon-btn effort-card__reset"
              title="重置为该模型的默认档"
              disabled={configBusy()}
              onClick={() => void setEffort(defaultTier())}
            >
              <IconRotateCcw />
            </button>
          </div>

          <button
            type="button"
            class="effort-card__model"
            aria-expanded={pickingModel() ? "true" : "false"}
            onClick={() => setPickingModel(!pickingModel())}
          >
            <span>{modelLabel()}</span>
            <IconChevronDown />
          </button>

          <Show when={pickingModel()}>
            <div class="effort-card__models" role="menu">
              <Show
                when={oauthActive()}
                fallback={
                  <div class="effort-card__custom">
                    <input
                      class="field-input"
                      value={customModel()}
                      placeholder="模型 id（自带 key 时自己填）"
                      onInput={(event) => setCustomModel(event.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="ghost-mini"
                      disabled={configBusy() || customModel().trim() === ""}
                      onClick={() => {
                        const next = customModel().trim();
                        if (next !== "") void setModel(next).then(() => setPickingModel(false));
                      }}
                    >
                      使用
                    </button>
                  </div>
                }
              >
                <Show
                  when={(catalogModels() ?? []).length > 0}
                  fallback={
                    <small class="effort-card__note">
                      {configError() ?? "模型目录为空：登录后重试，或在接入页确认套餐已启用。"}
                    </small>
                  }
                >
                  <For each={catalogModels() ?? []}>
                    {(entry) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={entry.slug === currentModel() ? "true" : "false"}
                        class={entry.slug === currentModel() ? "selected" : undefined}
                        onClick={() => {
                          void setModel(entry.slug).then(() => setPickingModel(false));
                        }}
                      >
                        <span>{modelSpec("plan", entry.slug).spec.displayName ?? entry.displayName}</span>
                        <small>{entry.slug}</small>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </Show>

          <div
            ref={(node) => {
              track = node;
            }}
            class={`effort-track effort-tone-${tierTone(tier())}${dragging() ? " is-dragging" : ""}`}
            role="slider"
            tabindex="0"
            aria-valuemin={0}
            aria-valuemax={tiers().length - 1}
            aria-valuenow={index()}
            aria-valuetext={TIER_LABEL[tier()]}
            onPointerDown={(event) => {
              setDragging(true);
              event.currentTarget.setPointerCapture(event.pointerId);
              applyPointer(event.clientX);
            }}
            onPointerMove={(event) => {
              if (dragging()) applyPointer(event.clientX);
            }}
            onPointerUp={(event) => {
              setDragging(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              void commitPending();
            }}
            onPointerCancel={() => {
              setDragging(false);
              setPending(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              void setEffort(stepTier(tiers(), tier(), delta));
            }}
          >
            <span class="effort-track__fill" style={{ width: `${fill()}%` }} />
            <For each={tiers()}>
              {(_, at) => (
                <span
                  class="effort-track__dot"
                  style={{ left: `${effortFillPercent(at(), tiers().length)}%` }}
                  aria-hidden="true"
                />
              )}
            </For>
            <span class="effort-track__thumb" style={{ left: `${fill()}%` }} />
          </div>

          <p class="effort-card__note">
            拖动或按 ←/→ 选择；拖动时预览，松手写入（只写这一个字段）。
          </p>
          <Show when={configError() != null}>
            {(message) => <p class="effort-card__note is-error">{message()}</p>}
          </Show>
        </div>
      </Show>
    </div>
  );
};
