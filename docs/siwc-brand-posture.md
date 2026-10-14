# SIWC 品牌资产口径（决策记录）

> 状态：已定稿（2026-10-14）。关联：`public/siwc/README.md`、`public/siwc/THIRD-PARTY-NOTICES.txt`、
> `src/siwc/brand.ts`、后端 `crates/qaqh-siwc`（`docs/analysis-signin-with-chatgpt-2026-10-14.md`）。

## 决策

采用 **1 + 2 组合口径**（不是二选一）：

1. **默认不分发**：两个仓库都不携带任何 OpenAI 图形资产；`public/siwc/` 只有三个说明文件。
   应用在资产缺失时回退**纯文字按钮**，登录与套餐用量功能完全不依赖资产。
2. **可选隔离引入**：使用者在明确接受约束的前提下，把官方 sign-in SVG 放进
   `public/siwc/`（或由 `README` 记录的 BYO 方式指向外部目录）。该目录
   **自带许可与 NOTICE，不受仓库根 MIT 覆盖**。

一句话：**接口支持两条路，仓库默认走第一条。**

## 事实基础

| 事实 | 依据 |
|---|---|
| 两个仓库都是 **MIT OR Apache-2.0**（2026-10-14 起） | `qaqh-backend/LICENSE-MIT` + `LICENSE-APACHE`、`qaqh-desktop-app/LICENSE-MIT` + `LICENSE-APACHE` |
| DevKit 是 Noncommercial 许可 | 上游 `LICENSE`（副本见 `public/siwc/LICENSE-SIWC-DEVKIT.txt`） |
| 「非商业」排除公司/雇主/客户场景 | 该许可 §1 对 Noncommercial Purpose 的定义（"whether or not a fee is currently charged"） |
| 不授予商标权 | 该许可 §5；商标另受 OpenAI brand guidelines 约束。**本仓自己的** MIT / Apache-2.0 同样不授予商标权（Apache-2.0 §6 明文排除），故「换许可」与「商标」是两件事 |
| 再分发义务 | §4(a) 随附许可副本、§4(b) 标注改动、§4(c) 保留声明、§4(d) 同许可 |

**这不是「许可风险」**：MIT / Apache-2.0 都不设这类条件，问题在**引入方向**——把更严的许可放进对外承诺 MIT OR Apache-2.0
的分发物，会让「整包双许可」这句话不再成立，且**用户商用这条闸门我们无权替他们打开**。
商标/背书风险独立于版权，且无法通过任何仓库内声明消解。

## UI 规则（后端字段 → 展示）

后端 `siwc.status` 是唯一判据（`crates/qaqh-siwc/src/manager.rs::status`）。

| 后端状态 | 文案 / 行动 | 硬规则 |
|---|---|---|
| `disconnected` | `Continue with ChatGPT` 按钮 | — |
| `connecting` | 「浏览器中完成授权…」+ 取消 | **不得**显示套餐标识 |
| `connected` + `sharing=true` | 显示账户（`label`/`email`）；composer 旁 **Using ChatGPT plan** + Manage usage | 首次成功登录一次性欢迎卡「You're using your ChatGPT plan」+ Got it |
| `connected` + `sharing=false` | 「已登录 · 套餐未启用」+ 去设置开启 | **不得**显示 **Using ChatGPT plan**（那是计费事实陈述） |
| `reauth_required` | 引导重新登录 | 不得自动重试登录；不得暗示仍是已连接 |
| `error.code = subscription_sharing_usage_limit_exceeded` 等 | **Manage usage** 为主行动；若应用自有额度则作次级行动 | 不得推断额度为空或重置时间 |
| `error.retryable = true` | 「稍后重试」，保留状态 | **不得**清凭据、不得引导重登 |

深链：一律用后端 `usageUrl`（`src/siwc/brand.ts::siwcUsageUrl` 已实现「后端优先、常量兜底」）。

## 禁止清单（违反即请改走「不引入」路径）

- 把 ChatGPT 标识用于暗示与 OpenAI 的合作、赞助或背书。
- 在登录/授权之外的场景做装饰性使用。
- `sharing=false` 时展示套餐标识或用量入口。
- 在本仓许可口径下（MIT OR Apache-2.0）再分发 `public/siwc/` 的内容。
- 把资产放进任何**会发布到包管理器**的产物（crates.io 要求整包 OSI 认可许可）。
  资产只允许待在桌面壳的静态资源里。

## 与后端的契约

| 服务面方法 | 用途 | 前端约束 |
|---|---|---|
| `siwc.status` | 连接状态投影 | **不含 token 字段**（后端结构上就不下发）；`sharing` 必读 |
| `siwc.profiles` | 账户列表 | `sharing` 为假时展示为「已登录 · 套餐未启用」 |
| `siwc.models` | 模型选择器 | 切账户后必须重取 |
| `siwc.sign_in.start` | 返回 `authorizeUrl` | 用**系统浏览器**打开（宿主 `open_external`）；不内嵌 webview |
| `siwc.sign_in.status` | 轮询流程终态 | 终态后不再轮询 |
| `siwc.sign_in.cancel` / `siwc.profile.select` / `siwc.sign_out` | 取消/切换/登出 | 登出返回 `revoked: false` 时提示「远端撤销未确认，可在 ChatGPT 设置里断开」 |

全部方法在 daemon 侧为 **admin_only**：配对设备（view/interact）调用一律 403
（用例见 `qaqh-daemon/src/axum_server/authz_matrix_tests.rs::siwc_methods_deny_devices_and_serve_admin_without_tokens`）。

## 待办

1. ~~**`LICENSE` 年份**：本仓库 `LICENSE` 写的是 `Copyright (c) 2027`（backend 是 2026），
   疑似笔误，待确认后修正。~~ **已修（2026-10-14）**：年份改 `2026`；并随双授权改名为
   `LICENSE-MIT`，另加 `LICENSE-APACHE`。
2. **安装包内附第三方许可清单**：打包产物含大量 MIT / Apache-2.0 依赖，按 Apache-2.0 §4
   应随附其许可与 NOTICE（`NOTICE` 已就位，随包清单待做）。
3. **真机联调**：目前后端全部结论只在 mock OIDC 上验证过；需用真实 Plus/Pro 账户
   跑通一次 `response.completed`。
4. **资产引入前的核对**：放入任何 SVG 前，用上游原文替换 `LICENSE-SIWC-DEVKIT.txt`
   并在 NOTICE 表格登记 commit + SHA-256 + 取用日期。
5. 后端 M1（`qaqh-gate` 的 Responses 兼容位）与 `siwc.*` 的类型化 DTO（当前 FE 用
   结构对齐的本地类型，见 `src/siwc/brand.ts::SiwcSessionStatus`）。

---

## 附：壳桥接与登录流程（2026-10-14 落地）

### 壳侧（Rust）

`src-tauri/src/commands.rs` 两处清单：
- `SERVICE_METHODS` 放行 8 个 `siwc.*`（该白名单的作用是让「前端能调哪些 daemon 方法」可审计）；
- `service_requires_session` 的**豁免**清单加同样 8 项。理由：ChatGPT 账户与套餐用量是
  daemon **全局态**，与活动会话无关；若不豁免，零会话（引导页第一件事就是登录）时会因
  注入 seed 失败直接报 `no_active_seed`，把登录入口彻底堵死。

授权 URL 仍由既有的 `open_external` 打开（只放行 http/https）；daemon 不 spawn 进程，也不内嵌 webview。

### 前端（TS）

`src/lib/siwc.ts`：8 个类型化封装 + `openExternal` + **`runSignInFlow`**（开工 → 开系统浏览器 →
轮询到终态）。刻意做成可注入依赖的纯驱动，因为轮询最容易出的是**静默挂死**，而那段逻辑在 UI 里没法测。

两个易错点已固化在实现里：

1. **超时也要取消流程**：留一个进行中的流程会把下一次登录挡在 `connection_busy` 上；
2. **被新登录顶掉**（daemon 返回 `profile_not_found`）报 `superseded` 而不是抛错。

### 验证

```
npx vitest run tests/siwc-*.test.ts    22 passed（3 文件：brand 6 / account-view 9 / flow 7）
npx tsc --noEmit                       src/siwc/** 与 src/lib/siwc.ts 零错误
cargo check --manifest-path src-tauri/Cargo.toml   无错
```

### 还没做：把组件挂进界面

`SiwcConnectionCard` / `SiwcPlanBadge` / `SiwcUsageLimitNotice` 都已就绪但**尚未挂载**——
挂载要动 `src/settings/SettingsView.tsx` 与 `src/composer/Composer.tsx`，
而这两个文件当前有未提交的改动（同一批里 `App.tsx` / `SessionView.tsx` 也在改），
现在插入会产生冲突。等那批编辑落定后再挂，或在确认后由我插入。

### 今天就试通的两种方式

1. **接 UI**：在设置页挂 `SiwcConnectionCard`（`onSignIn` 调 `runSignInFlow()`）→ 点按钮即登录。
2. **不走 UI**：拿 daemon discovery 里的 `endpoint` + admin token，
   `POST /ringing/v2/service/siwc.sign_in.start` → 把返回的 `authorizeUrl` 在浏览器打开 →
   `POST /ringing/v2/service/siwc.sign_in.status`（带 `flow_id`）看终态。
   配置侧需要 `[profiles.X] credential = "chatgpt_plan"` + `wire = "responses"`。
