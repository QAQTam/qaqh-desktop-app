# QAQ-Harness 桌面客户端（qaqh-desktop-app）

按 `agent-webui-phase1-spec.md`(v1.0)实现的对话页:SolidJS 2.0 rc + Vite +
TypeScript strict,运行在 **Tauri 2 桌面壳**(`src-tauri/`,crate
`qaqh-webui-app`)内。webui 浏览器 gateway 部署形态已随 Tauri 化移除
(plan-webui-tauri C3/D1)。

## 与后端仓的关系（重要）

本仓于 **2026-10-07** 从后端仓 `qaqh-backend` 的 `webui/` 抽出（含完整 git 历史）。

它**不是**可独立分发的产物，必须与后端仓同级共存：

- `src-tauri/Cargo.toml` 经 **path 依赖**吃后端仓的 `qaqh-client` / `qaqh-types`
  （`../../qaqh-backend/crates/...`，相对 `src-tauri/`）；
- `src/api/qaqh/*.ts` 是**生成物**，由后端仓 crate 的 `derive(TS)` 导出——
  生成动作在后端仓跑（`just ts-export`，见 justfile），本仓只提供落地目录。

后端仓不在同级时设 `QAQH_BACKEND_ROOT`（`place-sidecar.ps1` 与 justfile 都读它）。

daemon 的**权威构建在后端仓**；本仓只搬运它的产物为 Tauri sidecar。


## 许可与商标

本仓以 **MIT OR Apache-2.0** 双许可发布，下游可任选其一：

- `LICENSE-MIT` —— MIT
- `LICENSE-APACHE` —— Apache License 2.0（含显式专利授权 §3）
- `NOTICE` —— 版权与**商标**声明（同时满足 Apache-2.0 §4(d)）

`Cargo.toml`（workspace 与 `src-tauri`）与 `package.json` 的 `license` 字段与此一致。
后端仓 `qaqh-backend` 采用同一口径。

**关于「用 ChatGPT 登录」是否需要额外授权**：开源许可（MIT / Apache-2.0）**不授予任何
商标权**——Apache-2.0 §6 明文排除商标、服务标记与商品名；MIT 全文未涉及商标。
所以「换/加许可」既不会带来商标授权，也不解决商标问题，两者互不相干。项目中出现
「ChatGPT」「OpenAI」等名称，仅用于如实描述用户可登录的对象；本项目与 OpenAI
**无隶属、无赞助、无背书**。官方图形资产默认**不随仓分发**（`public/siwc/` 只有说明
文件），相关口径与禁止清单见 `docs/siwc-brand-posture.md`。


## 构建

```bash
pnpm install
pnpm run typecheck
pnpm run test      # 仅纯逻辑单测(spec §1.3)
pnpm run build     # 输出 out/renderer/,由 tauri.conf.json 的 frontendDist 消费
```

## 开发(桌面壳)

```bash
just desktop-dev   # 构建 daemon(debug)+ 放置 sidecar + pnpm tauri dev
```

`tauri dev` 会先跑 `pnpm run dev`(vite :5173),Rust 宿主以 devUrl 打开 webview;
宿主经 `qaqh-client` 直连 daemon——discovery 有兼容实例则复用,否则拉起
`target/debug/qaqh-daemon`(可用 `QAQH_DAEMON_PATH` 覆盖)。

### Intel macOS(x86_64)

`just desktop-dev` / `just desktop-build` 在 macOS 上是同一对名字,走 `[macos]` 变体,
产物三元组钉死 `x86_64-apple-darwin`(不靠 host 推断:Rosetta 下的 shell 会把
host tuple 也报成 x86_64)。前置四样:

```bash
xcode-select --install                                    # clang + SDK,Tauri 壳必需
rustup target add x86_64-apple-darwin                     # just verify-mac-target 断言它
brew install just pnpm                                    # 渲染层闸只认 pnpm + just
node -v                                                   # ≥ 22.12(rolldown 的 engines 下限)
```

daemon 侧的 sidecar 由 `scripts/place-sidecar.sh` 放置成
`src-tauri/binaries/qaqh-daemon-x86_64-apple-darwin`(`binaries/` 已在 .gitignore)。
打包目标与最低系统版本来自 `src-tauri/tauri.macos.conf.json`(Tauri 按三元组自动合并):
`.app` + `.dmg`,`LSMinimumSystemVersion = 15.0`。

跑壳侧闸(`just check-shell`)在 mac 上要把同一三元组贯穿三条命令:

```bash
cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon --target x86_64-apple-darwin
just place-sidecar debug x86_64-apple-darwin
just check-shell
```

最低 15 不只是政策:webview 层 `build.target` 是 `esnext`(不做降级),样式用了
`color-mix()`(Safari 16.2+)与 `:has()`/`@layer`(15.4+),而 macOS 的 WKWebView 跟系统
版本走。15 (Sequoia) 对应 Safari 18,整条 CSS 面都在支持内;反过来停在 12/13 的机器
会让 42 处 `color-mix()` 静默失效,叠上 `transparent: true` 的窗口就是黑底。

## 打包与版本

版本号**单源**是根 `Cargo.toml` 的 `[workspace.package] version`;`tauri.conf.json >
version` 是它的镜像(NSIS 包名与 exe 的 FILEVERSION 取那一处)。两处不许漂移——
`just build-verify` 会当场比,不等就红。设置页「关于」显示的是
`<version>-<git 短 sha>`,脏工作树再缀 `-dirty`,由 `src-tauri/build.rs` 注入。

`just desktop-build` 前后各有一道闸(`scripts/build-guard.mjs`),存在理由是同一个坑:
包名钉死在版本号上,版本又长期不 bump,于是打包前任何一步失败,上一次的安装包都会
原地留着、文件名一模一样,"我编译了但装上还是旧 UI"在产物层面无法自证。

- `just build-pre`:删掉 `target/release/bundle` 下的旧产物(没产物就是没成功),并断言
  已安装实例没在运行——壳有托盘 + single-instance,窗口关了进程不退,`qaqh-daemon`
  还锁着安装目录里的 exe,这时 NSIS 覆盖必败或静默跳过。**打包前先从托盘退出。**
- `just build-verify`:核验壳二进制里嵌的前端入口 hash 就是当前 `out/renderer` 的那两个
  文件名,再打印每个安装包的大小与 mtime。对不上就是旧包,报错会指出该重跑哪一条。

## 数据单源(架构契约)

| 事实 | 唯一来源 | 前端角色 |
|---|---|---|
| transcript 结构/文本 | timeline(宿主转发的快照 + `timeline://entry`,`watermark` 去重,缺口→快照校正) | 纯 reducer 投影 |
| 审批/AskUser 待处理 | `pending_approvals` IPC(challenge 由宿主签发,canonical id 不出宿主) | 投影事件只当刷新信号 |
| 会话标题/运行态/后台「有新回复」点 | `session_list` IPC(按契约 G2 的 `SessionListEntry` 投影)+ `projection://event` 的 MetaDelta 触发重拉 | 对比渲染;事件只当刷新信号 |
| diff | 后端 unified diff 文本(`display.body.diff.unified`) | 解析渲染,不重算 |
| 工具展示 | 后端 `display` 投影(header/body/metrics) | 直接消费;`args_json` 仅作未注册回退 |

## 宿主契约(为什么只有活动标签持流)

Rust 宿主维护「单一 active seed 持流」(plan-webui-tauri D4):切标签 =
attach(宿主切 active + 重建 timeline/v2 流)+ 快照重建。重连/退避/续传责任在
宿主(qaqh-client 的 V2Stream/timeline 流自带重连),前端 `timeline://status`
驱动 connection 信号;offline 后由用户动作(重试按钮/窗口聚焦)触发
`streams_retry`。daemon lease 本身支持一个 client 拥有多个 seed,放开并行流
属上线后增强。

窗口关闭 = 宿主 detach(`Client::close()`),daemon 与运行中的 Turn/待审批
继续存活(§5.3 语义);宿主退出**不**调用 `stop_daemon`。

## 已知契约缺口(实现内的 `[契约缺口]` 注释)

- **TS-1** 后端 `TimelineEntry` 无 epoch-ms 时间戳 → 耗时/偏移用客户端时钟采样,
  集中在 `src/lib/time.ts`;后端补 `ts` 后换一处即可转正。
- **A-1** 授权 challenge details 不携带 `choices[]` → 按宿主 `command_for` 的
  固定决策集渲染;后端补 choices 后按列表渲染。
- **D-1** 后端 diff 无结构化 `stats` → 由后端 diff 文本行数统计;后端补
  stats 后前端统计退役。

## 推理强度档位（词表权威在哪）

档位阶梯在前后端各有一份镜像，**改动前先看清哪份是权威**：

- 后端权威 = `origin/main`：`qaqh-gate/src/types.rs::EFFORT_LADDER` 六档
  `low|medium|high|xhigh|max|ultra`，`ConfigPatch::validate` 同词表。加 `ultra`
  的那次提交是 `aa7f2b3`（2026-10-14 11:17）。
- 前端镜像 = `src/models/specs.ts::EFFORT_LADDER`（强度轨道）与
  `src/settings/patch.ts::REASONING_EFFORTS`（设置页下拉）。两处必须同序，
  `tests/settings-patch.test.ts` 有一条不变量测试钉住它。
- **别拿本地那份 `../qaqh-backend` checkout 当权威**：它可能停在冻结基线
  （`6a0e282`，10-10，无 `ultra`）且已与 origin 分叉。按它改档位会把合法档砍掉。
- `[契约缺口] S-1` 随仓 sidecar `src-tauri/binaries/qaqh-daemon-*` 目前是
  `2.0.0-beta.3`（10-11 构建，早于 `aa7f2b3`），字符串里没有 `ultra`，也就是说
  **这个二进制会拒 `ultra`**。要么把后端仓更新到 RC1 再重编 sidecar（`tauri.conf.json`
  的 `beforeBuildCommand` 从 `../qaqh-backend` 出 `--target-dir ../target`），
  要么在发行说明里写清当前档位上限。这也是 `Cargo.lock` 里
  `qaqh-types` 版本漂移（`2.0.0-RC1` vs `beta.3`）的同一个根因。

## 应用内截图（⌘⇧S）

前端要报一个界面问题，最难的一步是"把当时那一屏给我看"。所以壳里接了一条截图：

- **键位**：`⌘⇧S`（macOS）/ `Ctrl+Shift+S`。判定在 `src/lib/screenshot.ts::isScreenshotShortcut`，
  挂在 `src/app/App.tsx` 的全局快捷键面上，位置在"设置浮层归浮层"那条规则**之前**——
  设置页（OAuth/BYOK 那些字段）正是最需要截图的地方，浮层开着也该能截。
- **入口**：除了键，输入区与 Startup 页各有一个相机按钮（宿主给不了截图的形态下不渲染）。
- **实现在宿主**：`src-tauri/src/commands.rs::capture_screenshot` 调系统的
  `/usr/sbin/screencapture`（`-x` 静音、选区态加 `-i`，同时把图丢进剪贴板 `-c`），
  写到**应用临时目录**，只回 `{path,name,size}`。渲染层拿这个路径走既有的
  `upload_attachment` —— 不为截图新辟上传口，字节也永远不进 webview。
- **落点**：有活动会话 → 输入区附件 chip；还在 Startup（会话未建）→ 暂存列表，
  随首条消息一起上传。取消（准星上按 Esc）与失败分开报，不会挂出一个空附件。
- **平台**：目前只有 macOS 有实现，非 mac 那条命令直接返回"不支持"并说明改用系统
  截图键 + 「添加附件」。要 Windows 的原生面需要另接 API（Windows.Graphics.Capture），
  那是另一件事。
- **权限（要用户动手的一次）**：macOS 11 起截屏受「屏幕录制」TCC 管控。首次会由系统
  弹授权；**未授权时 `screencapture` 仍可能退出 0 但给出全黑图**，这条只能在
  系统设置 → 隐私与安全性 → 屏幕录制 里放行，本应用不猜、也不代填。

## 安全边界

- **token 面**:daemon bearer token / lease id 只存在于 Rust 宿主进程;
  webview 可达面仅类型化 IPC + 宿主转发事件(devtools 可核验)。
- **审批防御纵深**:webview 只见宿主签发的不透明 challenge id(64 hex,
  TTL 5min,一次性消费 + active-seed scope 校验),canonical `call_*`/`int_*`
  id 不出宿主。
- Markdown:marked + DOMPurify,远程图片降级为文字链接,外链经宿主
  `open_external` 走系统浏览器(仅 http/https)。
- diff/工具输出:textContent 构建,不经 innerHTML;ANSI 经 anser 解析为节点。
- 工具行内无手绘 SVG(unplugin-icons + lucide);无打包字体;CSP 由
  `tauri.conf.json > app.security.csp` 单点接管(`default-src 'self'` + ipc)。
- 外链/导航:webview 内不导航外站;IPC 面即 `invoke_handler` 注册白名单,
  `service_rpc` 另有方法白名单(与原 gateway 代理面一致)。
- **用户级 skills**:`~/.qaqh/skills`、`~/.agents/skills` 不在 daemon `fs.*` 的
  allowed_roots 内,由宿主命令 `skills_user_scan`(`src-tauri/src/skills.rs`)自己
  读盘交给渲染层。命令**不收路径参数**——扫哪些根由宿主按平台 home 算死,渲染层
  拿不到「读任意文件」的口子;回包只有这两个根下的 `SKILL.md` 正文(单文件 ≤512KB、
  总量 ≤8MB)。
