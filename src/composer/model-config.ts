/**
 * 作曲家侧的**全局模型/强度状态**。
 *
 * 为什么放在这里而不是 composer 组件内部：强度和模型是 **daemon 全局配置**，
 * 不属于任何一条会话（会话级的是 profile，走 `session.set_profile`）。这一层
 * 只做三件事：
 *
 * 1. 读一次 `config.load`（credential / model / reasoningEffort 都从这一份来）；
 * 2. 写的时候**只发改动的那个字段**（K3 合并补丁）——绝不整包写回，否则会把
 *    设置页里未保存的草稿一起提交；
 * 3. 写成功后把该字段记进**当前 provider 的槽位**（`../oauth/provider-state`），
 *    于是切换 provider 时能连带把强度/模型一起换过去、换回来。
 *
 * 强度卡是**全局**的：BYOK 与套餐都走它。可用档位由模型特判决定
 * （`../models/specs` 的 `efforts`，缺省 = 全阶梯，后端再按端点 compat 钳制）。
 */
import { createSignal } from "solid-js";

import type { ConfigDto } from "../api/qaqh/ConfigDto";
import { siwcModels, type SiwcModelEntry } from "../lib/siwc";
import { transport } from "../lib/transport";
import { modelEfforts, modelSpec, type ReasoningTier, type SpecBucket } from "../models/specs";
import { isOauthMode } from "../oauth/mode";
import {
  activeProviderId,
  loadState,
  rememberState,
  saveState,
  type ProviderStateMap,
} from "../oauth/provider-state";

/** 已保存事实（`config.load`）。null = 还没读到（或读失败）。 */
const [config, setConfig] = createSignal<ConfigDto | null>(null);
const [catalog, setCatalog] = createSignal<SiwcModelEntry[] | null>(null);
const [catalogError, setCatalogError] = createSignal<string | null>(null);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export { busy as configBusy, catalogError, error as configError };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 当前凭据来源决定模型特判读哪个桶。 */
export function specBucket(): SpecBucket {
  return isOauthMode(config()) ? "plan" : "byok";
}

export const currentModel = (): string => config()?.model ?? "";
export const currentEffort = (): string => config()?.reasoningEffort ?? "";
export const oauthActive = (): boolean => isOauthMode(config());
export const catalogModels = (): SiwcModelEntry[] | null => catalog();

/** 当前模型可用的档位（缺省全阶梯）。 */
export function availableTiers(): readonly ReasoningTier[] {
  return modelEfforts(modelSpec(specBucket(), currentModel()).spec);
}

/** 当前模型的默认档（重置键用）。 */
export function defaultTier(): ReasoningTier {
  const spec = modelSpec(specBucket(), currentModel()).spec;
  const allowed = modelEfforts(spec);
  if (spec.defaultEffort != null && allowed.includes(spec.defaultEffort)) return spec.defaultEffort;
  return allowed[Math.floor(allowed.length / 2)] ?? "medium";
}

export async function refreshConfig(): Promise<void> {
  try {
    setConfig(await transport.rpc<ConfigDto>("config.load"));
    setError(null);
  } catch (cause) {
    setError(messageOf(cause));
  }
}

/**
 * 拉一次套餐模型目录。BYOK 模式下**不拉**——那个目录是账户级的，与自带端点无关。
 * 失败不清空已有目录：一次网络抖动不该让选择器变空。
 */
export async function loadCatalog(): Promise<void> {
  if (!oauthActive()) return;
  try {
    setCatalog(await siwcModels());
    setCatalogError(null);
  } catch (cause) {
    setCatalogError(messageOf(cause));
  }
}

/** 只发一个字段的合并补丁，并把结果记进当前 provider 的槽位。 */
async function patchAndRemember(field: "model" | "effort", value: string): Promise<boolean> {
  const current = config();
  if (current == null || busy()) return false;
  setBusy(true);
  setError(null);
  try {
    const payload = field === "model" ? { model: value } : { reasoningEffort: value };
    await transport.rpc("config.save", payload);
    // 记进槽位：切换 provider 时这一份要能跟着走。
    const states: ProviderStateMap = rememberState(
      loadState(),
      activeProviderId(current),
      field === "model" ? { model: value } : { effort: value },
    );
    saveState(states);
    await refreshConfig();
    return true;
  } catch (cause) {
    setError(messageOf(cause));
    return false;
  } finally {
    setBusy(false);
  }
}

export const setEffort = (tier: ReasoningTier): Promise<boolean> => patchAndRemember("effort", tier);
export const setModel = (model: string): Promise<boolean> => patchAndRemember("model", model);
