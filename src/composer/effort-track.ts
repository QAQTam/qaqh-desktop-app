/**
 * 强度轨道的**纯逻辑**：指针位置 ↔ 档位、填充比例、键盘步进、配色档。
 *
 * 单独拆出来是因为这段最容易写错、又最难在界面上发现：拖到最左/最右差一格、
 * 填充宽度算成拇指中心、键盘步进越过端点……在组件里都只能靠肉眼。这里全是
 * 纯函数，脱浏览器可测（`tests/effort-card.test.ts`）。
 *
 * 档位阶梯本身来自 `../models/specs`（`EFFORT_LADDER`），与 Codex 的
 * low → medium → high → xhigh → ultra 一致。
 */
import type { ReasoningTier } from "../models/specs";

/** 指针横坐标 → 档位下标。`rect` 是轨道的可视矩形（含 padding 的部分不算）。 */
export function tierIndexForPointer(
  clientX: number,
  rect: { left: number; width: number },
  tierCount: number,
): number {
  if (tierCount <= 1 || rect.width <= 0) return 0;
  const ratio = (clientX - rect.left) / rect.width;
  const clamped = Math.min(1, Math.max(0, ratio));
  // 四舍五入到最近的档：拖动时"过半才跳"，松手前后手感一致。
  return Math.min(tierCount - 1, Math.max(0, Math.round(clamped * (tierCount - 1))));
}

/** 填充宽度：第 `index` 档占轨道的百分比。拇指中心落在档位上，所以两端要留半格。 */
export function effortFillPercent(index: number, tierCount: number): number {
  if (tierCount <= 1) return 0;
  const clamped = Math.min(tierCount - 1, Math.max(0, index));
  return (clamped / (tierCount - 1)) * 100;
}

/** 键盘步进（←/→）。到端点就停住，不循环——循环会让"最强档"多按一下变最弱。 */
export function stepTier(
  tiers: readonly ReasoningTier[],
  current: ReasoningTier,
  delta: number,
): ReasoningTier {
  const fallback = tiers[0];
  if (fallback == null) return current;
  const at = tiers.indexOf(current);
  if (at < 0) return fallback;
  const next = Math.min(tiers.length - 1, Math.max(0, at + delta));
  return tiers[next] ?? fallback;
}

/**
 * 配色档：`high` 以下与 `xhigh` 都是绿，`ultra` 才换成紫金渐变 + 星点。
 *
 * 对齐 Codex 的视觉分级（截图：高 = 绿、Ultra = 紫 + 星），**不是**每档一个颜色：
 * 颜色承担的是"这档有多猛"的分级，档位名已经说清了具体是哪一档。
 */
export function tierTone(tier: ReasoningTier): "normal" | "ultra" {
  return tier === "ultra" ? "ultra" : "normal";
}
