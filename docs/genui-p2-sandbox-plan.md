# qaqh-ui P2 计划:沙箱化 HTML/富内容 widget(qaqh-sandbox)

状态:计划稿 · 2026-10-15 · 前端仓(含 src-tauri 壳)范围
前置:P0+P1 已落地(A2UI 消息流管线,`docs/genui-v02-a2ui-migration.md`)

## 0. 目标与边界

让模型能在回答里嵌入**真正自由的 HTML/CSS/JS 富内容**(图表、交互演示、mermaid 图、数学公式),渲染在**强隔离的沙箱帧**里;主文档与 daemon IPC 对沙箱代码零暴露。

**做**:沙箱协议、桥、fence 分流、本地渲染库打包、高度自适应、主题注入、followUp/copy 动作回传。
**不做**(本期):意图动作进后端授权层(独立后端提案)、双向大数据同步、模型直写主文档。

## 1. 借鉴与自写的边界(结论)

| 内容 | 来源 |
|---|---|
| 沙箱域白名单校验、能力端口白名单、initId 四重绑定(origin+path+参数+id)、主进程纯搬运 | **抄 ChatGPT 协议设计**(已逆向:`web-sandbox.oaiusercontent.com` + 19 端口 + `codex-sandbox:`),裁剪为我们需要的子集 |
| iframe + postMessage 桥 | 浏览器原语自写(~250 行),框架无关,无 React/Solid 库依赖 |
| mermaid / mathlive / katex | vanilla JS 成熟库,**本地打包**进沙箱页(对齐 ChatGPT 零 CDN 纪律) |
| 声明式目录渲染 | 不引 A2UI 官方 Lit renderer——自有 Solid renderer 已落地,只用其 spec + conformance |

## 2. 安全模型(不可妥协项)

1. **`<iframe sandbox="allow-scripts">`,绝不加 `allow-same-origin`**——opaque origin:摸不到父 DOM/localStorage/cookie/Tauri IPC(`__TAURI__` 不注入 opaque 帧)。
2. 宿主→沙箱唯一通道:`postMessage`,**显式 targetOrigin**;沙箱→宿主经 `MessageChannel` 端口,端口在握手时一次性授予(对齐 ChatGPT init 握手:initId 校验 `^[A-Za-z0-9_-]{1,128}$`、端口集合必须完整、缺一拒绝)。
3. 沙箱页自带 **CSP**:`default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:;`——不允许外连。
4. 资源体积预算:HTML ≤ 256KB(对齐 dataModel 预算),mermaid 图源 ≤ 64KB。
5. 崩溃/超时:iframe load 超 10s 未 ready → 具名错误占位卡;onError 上报。

## 3. 架构

```
模型:```qaqh-html 围栏(完整 HTML 文档片段,内联 <style>/<script>)
  → decoder(新 fence 类型,版本字段 "html")
  → streaming:源码视图(只读 <pre>,带语言提示),绝不流式渲染未闭合 HTML
  → seal:HtmlWidget 组件挂载
      → <iframe sandbox="allow-scripts" src="sandbox:widget/{surfaceId}?init=<initId>">
      → 主文档 HtmlWidgetBridge:createChannel(ports) → iframe.contentWindow.postMessage(init, ports)
      → 沙箱页(由 qaqh-sandbox: 协议服务)校验 initId/origin → 申请端口 → 渲染模型 HTML
      → ready/height 上报 → 宿主自适应高度 + data-streaming 摘除
```

Tauri 壳:`register_uri_scheme_protocol("qaqh-sandbox", ...)` 从打包资源服务固定宿主页
(`sandbox/host.html` + vendored mermaid 等),资源路径白名单,拒绝 `..`;宿主页再把模型 HTML
经端口写入(模型 HTML 不过 URL,避免长度/转义问题)。

## 4. 桥能力面(裁剪自 ChatGPT 19 端口;v1 只开 7 个)

**宿主 → 沙箱**:
- `setDocument {html}` —— seal 后注入模型 HTML(一次性)
- `setTheme {tokens}` —— 设计 token(CSS variables),视觉与主文档一致
- `setData {path, value}` —— 预留:v0.2 dataModel → widget 数据推送(本期可只实现接口)

**沙箱 → 宿主**:
- `ready {height}` —— 挂载完成 + 初始高度
- `resize {height}` —— ResizeObserver 上报高度变化
- `followUp {prompt, fields}` —— 走现有会话输入队列(与 qaqh.action.followUp 同语义,不开 toolcall)
- `copy {text}` / `openLink {url}`(仅 http(s),主文档侧执行——沙箱内 window.open 被 sandbox 禁)

渲染库暴露给模型的方式:沙箱页预置全局 `qaqh.mermaid.render(source) -> svg`,
模型 HTML 里 `<div data-mermaid="graph TD; A-->B">`,宿主页 boot 脚本统一渲染——
模型不需要知道 mermaid API,只需要会写图源。

## 5. 里程碑

### P2.1 fence + decoder(0.5 天)
- [ ] decoder 接受 ` ```qaqh-html ` 围栏(info 可带 `lang=mermaid` 等提示),`UiSourcePart` 增
      `kind: "html"` 或复用 ui part + format:"html"(倾向后者,少一个联合分支)
- [ ] holdback/配对语义与 qaqh-ui 完全一致(纯函数测试补 fuzz 用例)

### P2.2 沙箱协议页 + 壳(1 天,src-tauri)
- [ ] `src-tauri/src/sandbox.rs`:注册 `qaqh-sandbox` 协议,服务 `sandbox/host.html`
      与 vendored 资源(路径白名单);浏览器预览(browser-preview)路径同步支持
- [ ] `sandbox/host.html` + `host.js`:CSP、init 握手、端口校验、boot 脚本
      (mermaid/mathlive 初始化、data-mermaid 扫描)

### P2.3 HtmlWidget 组件 + 桥(1 天)
- [ ] `src/genui/html/Bridge.ts`:MessageChannel 建立、init 握手、超时具名错误
- [ ] `src/genui/html/HtmlWidget.tsx`:seal-then-render、高度自适应、主题注入、
      源码视图(生成中)/渲染视图(sealed)切换
- [ ] AssistantContent 分流:format === "html" → HtmlWidget(与 v0.1/v0.2 并列第三轨)

### P2.4 动作回传(0.5 天)
- [ ] followUp 接 `onFollowUp` 队列;copy/openLink 白名单执行
- [ ] 沙箱错误上报 → 占位卡具名错误(对齐 genui 错误纪律)

### P2.5 视觉验收 + 安全自查(0.5 天)
- [ ] `genui-check` 增 html 区块:mermaid 图、交互按钮(followUp 回显)、超预算用例、坏 HTML 用例
- [ ] 自查清单:无 allow-same-origin / CSP 生效 / IPC 不可达 / 体积预算 / targetOrigin 显式

## 6. 风险

| 风险 | 缓解 |
|---|---|
| Tauri custom protocol 在 dev/browser-preview 两条路径行为不一 | P2.2 同时实现并各加一条夹具;`qaqh-sandbox` 在 http 预览下降级为 blob URL iframe |
| 上游 A2UI/Chromium 沙箱语义漂移 | 桥是自有协议,不绑 A2UI 版本;vendored schema 变更只影响 v0.2 轨 |
| 模型 HTML 里内联 script 滥用 setTimeout 轮询拖垮渲染 | 沙箱帧独立事件循环,崩了只挂自己;宿主侧 onError 具名 + 手动重载按钮 |
| followUp 语义被当成 toolcall | 桥接层直接复用 `onFollowUp` 队列,与 qaqh.action.followUp 同一条路径,无新增后端面 |

## 7. 明确非目标(记录在案)

- 主文档 innerHTML 渲染模型 HTML(XSS 面)
- `allow-same-origin`(等于没隔离)
- HTML 流式渲染(标签不配对,必然跳动;源码流 + seal 渲染已覆盖体验)
- 意图动作授权化(后端独立提案,见 migration doc §3 P2 daemon 侧)
