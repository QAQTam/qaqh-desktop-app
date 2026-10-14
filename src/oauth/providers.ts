/**
 * 接入服务商名录 —— **前端代管多 provider** 的那份名册。
 *
 * 为什么不落在后端配置里：后端短期内没有 per-provider 的结构（见
 * `../models/specs.ts` 顶部），而"同时接入几家、各自记住自己的模型与端点"是
 * **编排**问题。所以前端持有名册与每家的状态（`./provider-state`），切换时
 * 只把**当前生效那家**的字段用合并补丁写进 daemon 配置。
 *
 * 两条边界：
 * - 凭据本体不在这里（将来接友商的 key 也走 daemon 的加密存储，前端只拿投影）；
 * - 名册自检见 `providerRegistryProblems()`——加一条写错当场露馅（有测试）。
 */

/**
 * 凭据来源的三种形态。`byok` = 自带端点与密钥；`plan` = ChatGPT 套餐额度；
 * `account` = DeepSeek 账号余额（同样是"账号额度"，但**另一家**、另一套 wire）。
 */
export type ProviderKind = "byok" | "plan" | "account";

export type ProviderEntry = {
  /** 稳定 id：既做列表 key，也做每 provider 状态的槽位名。 */
  id: string;
  /** 展示名（官方品牌写法，不改写）。 */
  name: string;
  /** 卡片正面一句话。 */
  blurb: string;
  kind: ProviderKind;
};

/** 默认（无套餐）时生效的那一家。切回它时要把它的状态还原回去。 */
export const BYOK_PROVIDER_ID = "byok";

/** 套餐那一家。当前只有 OpenAI（友商接入时另加条目）。 */
export const PLAN_PROVIDER_ID = "openai";

/** DeepSeek 账号那一家（`credential = deepseek_account`）。 */
export const DSACCOUNT_PROVIDER_ID = "deepseek-account";

/**
 * 名录。顺序即展示顺序：先套餐（用户最常开的），再自带 key。
 *
 * **只放真能用的**：占位卡点了没反应，比没有更糟。
 */
export const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: PLAN_PROVIDER_ID,
    name: "OpenAI",
    blurb: "用本机 ChatGPT 套餐额度完成推理，无需配置 API key。",
    kind: "plan",
  },
  {
    id: BYOK_PROVIDER_ID,
    name: "自带 API key（BYOK）",
    blurb: "填你自己的端点与密钥，模型名由你决定。",
    kind: "byok",
  },
];

export function providerById(id: string): ProviderEntry | null {
  return PROVIDERS.find((entry) => entry.id === id) ?? null;
}

/** 名录自检：id 唯一、字段非空、恰好一家 byok。加条目时写错会在这里当场露馅。 */
export function providerRegistryProblems(entries: readonly ProviderEntry[] = PROVIDERS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let byok = 0;
  for (const entry of entries) {
    if (entry.id.trim() === "") problems.push("存在空 id 的条目");
    if (seen.has(entry.id)) problems.push(`id 重复: ${entry.id}`);
    seen.add(entry.id);
    if (entry.name.trim() === "") problems.push(`${entry.id} 缺展示名`);
    if (entry.blurb.trim() === "") problems.push(`${entry.id} 缺一句话说明`);
    if (entry.kind === "byok") byok += 1;
  }
  // 恰好一家：0 家 = 关掉套餐后无处可退；2 家 = "关套餐"该退到哪家没有答案。
  if (byok !== 1) problems.push(`byok provider 应恰好一家，实际 ${byok} 家`);
  return problems;
}
