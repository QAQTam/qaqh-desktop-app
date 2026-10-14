/**
 * 模型特判合集 —— **单一数据源**，前端代管。
 *
 * ## 为什么在前端
 *
 * 后端（SDK / daemon）短期内没有 per-provider 的模型结构可挂（`mutilproviderconfig`
 * 那类东西），而"这个模型支持哪些档位、窗口多大、默认哪档"是**展示与选择**的事，
 * 不影响请求形状（请求形状由后端的 compat 收口）。所以照 Codex 的做法：
 * 上游目录只给 slug/displayName（`siwc.models` 实测如此），**其余特判自己收一份**。
 * 代价要说清：这份数据是**我们维护**的，上游新增模型时不会自动出现——目录里有而
 * 这里没有的模型，一律走保守缺省（见 `modelSpec().known`）。
 *
 * ## 与 Codex 的对应关系
 *
 * | Codex | 这里 |
 * |---|---|
 * | `defaultThinkingEffortByModelSlug` | `defaultEffort` |
 * | `sliderSettings[{modelSlug, thinkingEffort}]` | `efforts`（该模型允许的档位） |
 * | 模型目录里的 `modelContextWindow` | `contextWindow` |
 *
 * 档位阶梯与 Codex 一致（low → medium → high → xhigh → ultra）；后端在同一阶梯上
 * 按端点 compat 钳制（`qaqh-gate/src/types.rs::EFFORT_LADDER`）。
 */

/** 推理强度档位。顺序即阶梯，由弱到强。 */
export type ReasoningTier = "low" | "medium" | "high" | "xhigh" | "ultra";

/** 全阶梯。缺 `efforts` 的模型按它展示（真实可用性由后端钳制兜底）。 */
export const EFFORT_LADDER: readonly ReasoningTier[] = ["low", "medium", "high", "xhigh", "ultra"];

/** 未收录模型的保守缺省。**不要**在这里给"更强"的值：猜大了会撞上游上限。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_EFFORT: ReasoningTier = "medium";

export type ModelSpec = {
  /** 展示名；上游 `displayName` 缺失时用它兜底。 */
  displayName?: string;
  /** 该模型支持的档位；缺省 = 全阶梯。 */
  efforts?: readonly ReasoningTier[];
  /** 默认档位（Codex 的 `defaultThinkingEffortByModelSlug`）。 */
  defaultEffort?: ReasoningTier;
  /** 上下文窗口（本地压缩分母）。 */
  contextWindow?: number;
  /** 备注：给后来的人看"这条为什么这么写"。 */
  notes?: string;
};

/**
 * 合集本体。`plan` 的 slug 来自 `siwc.models` 的**实测**（2026-10-14，
 * 账户 tsy3minso@gmail.com）；`byok` 只收我们确实知道差异的模型——用户自己的
 * 端点上的模型千变万化，编一份表反而有害。
 */
export const MODEL_SPECS: {
  plan: Record<string, ModelSpec>;
  account: Record<string, ModelSpec>;
  byok: Record<string, ModelSpec>;
} = {
  plan: {
    // 套餐模式统一 565K（产品口径）：上游目录不给窗口，按同一个数字收口，
    // 免得每个模型各写一个没人验证过的值。
    "gpt-6.1-sol": { displayName: "GPT-6.1 Sol", contextWindow: 565_000 },
    "gpt-6-astra": { displayName: "GPT-6-Astra", contextWindow: 565_000 },
    "gpt-6-sol": { displayName: "GPT-6-Sol", contextWindow: 565_000 },
    "gpt-6-luna": { displayName: "GPT-6-Luna", contextWindow: 565_000 },
    "gpt-5.6-sol": { displayName: "GPT-5.6-Sol", contextWindow: 565_000 },
    "gpt-5.6-terra": { displayName: "GPT-5.6-Terra", contextWindow: 565_000 },
    "gpt-5.6-luna": { displayName: "GPT-5.6-Luna", contextWindow: 565_000 },
  },
  // BYOK：空是有意的。收录一条就必须能说出它的差异；说不出就别写。
  byok: {},
  /*
   * DeepSeek 账号（`deepseek_account`）：**实测**（2026-10-14，
   * `GET https://api.deepseek.com/models` 带账号凭据）拿到 1M 窗口 / 393216 输出。
   *
   * 档位只收**平台自己声明的**：它给的是 `effort.supported_levels: ["low","high","max"]`。
   * 我们的阶梯里没有 `max`（见 `ReasoningTier`），所以这里只放 `low` / `high`——
   * 放一个平台不认的档，请求会以 400 打在推理端点上（比"少一档"糟得多）。
   * 平台真有 `max` 而我们没暴露，是**已知缺口**，等阶梯对齐后再补。
   */
  account: {
    "deepseek-flash": {
      displayName: "DeepSeek Flash",
      contextWindow: 1_000_000,
      efforts: ["low", "high"],
      defaultEffort: "high",
      notes: "实测：1M 窗口 / 393216 输出 / 多模态；平台档位 low|high|max",
    },
    "deepseek-v4-pro": {
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1_000_000,
      efforts: ["low", "high"],
      defaultEffort: "high",
      notes: "实测：1M 窗口 / 393216 输出 / 纯文本；平台档位同 flash",
    },
  },
};

/** Provider 归类：套餐走 `plan`，DeepSeek 账号走 `account`，其余（BYOK）走 `byok`。 */
export type SpecBucket = "plan" | "account" | "byok";

export type ModelSpecLookup = {
  spec: ModelSpec;
  /** `false` = 合集里没有这条，字段全是保守缺省（UI 该据此标「未收录」）。 */
  known: boolean;
};

/**
 * 查一条模型特判。**未收录不报错**：上游随时会加模型，报错会让选择器整个坏掉；
 * 但必须把 `known: false` 透出去，界面才有机会说"这个模型我们没收录"。
 */
export function modelSpec(bucket: SpecBucket, model: string): ModelSpecLookup {
  const found = MODEL_SPECS[bucket][model];
  return found == null ? { spec: {}, known: false } : { spec: found, known: true };
}

/** 该模型可选的档位（缺省 = 全阶梯）。 */
export function modelEfforts(spec: ModelSpec): readonly ReasoningTier[] {
  return spec.efforts ?? EFFORT_LADDER;
}

/** 该模型的默认档位（不在可选档位里时落到最弱档，别给一个它不支持的档）。 */
export function modelDefaultEffort(spec: ModelSpec): ReasoningTier {
  const allowed = modelEfforts(spec);
  if (spec.defaultEffort != null && allowed.includes(spec.defaultEffort)) return spec.defaultEffort;
  return allowed[0] ?? DEFAULT_EFFORT;
}

/** 该模型的上下文窗口（缺省 = 保守值，不是"很大"）。 */
export function modelContextWindow(spec: ModelSpec): number {
  return spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}
