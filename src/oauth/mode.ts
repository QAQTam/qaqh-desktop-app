/**
 * OAuth（套餐）模式的**判定与常量**——页面与设置页共用。
 *
 * 开关本身就是配置契约里的 `credential`：`chatgpt_plan` = 用本机 ChatGPT 套餐，
 * `api_key` = BYOK。也就是说「OAuth 打开」不是一个独立的开关位，而**就是配置本身**
 * ——换个端（TUI、手改 `config.toml`）看也一致，不会出现「UI 说开着、daemon 说没开」。
 *
 * **切换时要写哪些字段**不在这里，而在 `./provider-state`：那是"多 provider 各自
 * 记着自己的模型与端点"的事，涉及快照与还原，单独放一处免得两边各写一套。
 *
 * 本模块不碰 DOM 也不碰 store，纯函数，脱浏览器可测。
 */
import type { ConfigDto } from "../api/qaqh/ConfigDto";

/** 凭据来源的两个取值（与 `qaqh_types::CredentialSource` 的 serde 表示同源）。 */
export type CredentialSource = "api_key" | "chatgpt_plan";

/** 当前是否处于 OAuth（套餐）模式。 */
export function isOauthMode(
  config: Pick<ConfigDto, "credential"> | null | undefined,
): boolean {
  return config?.credential === "chatgpt_plan";
}

/**
 * 套餐模式下的上下文窗口：**统一 565K**（产品口径）。
 *
 * 这是**本地压缩的分母**（决定我们何时压历史），从不发给上游。上游的模型目录
 * 目前不给我们窗口（`siwc.models` 只有 slug/displayName），所以取一个固定值——
 * 比让用户按 BYOK 习惯填一个偏大的数字更安全：填大了会直接撞上游上限。
 * 同一份数字也在 `../models/specs.ts` 的 plan 条目里（那边是按模型给）。
 */
export const OAUTH_CONTEXT_LENGTH = 565_000;
