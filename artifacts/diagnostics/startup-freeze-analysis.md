# Linux 启动后界面无响应：诊断记录

## 已确证的直接故障

2026-10-23 本机运行中的 release 宿主 PID 5209 于 11:57:41 启动，WebKitWebProcess PID 5228 于 11:57:43 SIGABRT。
`coredumpctl info 5228` 的 Control Group 指向本仓 `target/release/qaqh-webui-app`，不是同机另一个 WebKit 应用。
宿主仍在正常 poll，保留 WebKitNetworkProcess 5226，但界面渲染进程已消失。
可用内存约 5.3 GiB，swap 使用 0，当前没有内存耗尽证据。

## 根因链

1. `src-tauri/src/main.rs:5-17` 在 Linux 启动时，若环境变量未设置，强设 `WEBKIT_DISABLE_DMABUF_RENDERER=1`。
2. `/proc/5226/environ` 证实实际存活的宿主子进程继承到了该变量。
3. 本机 WebKitGTK 2.54.1 中，原生探针观察到该变量让默认硬件加速策略由 1 (ALWAYS) 变成 2 (NEVER)。
4. 前端启动 `App.tsx:173` → `tabs/store.ts:519` → 有会话时 `openSession`/`activateTab`，无会话时 `openStartup`；两条路都调用 `withViewTransition` (`tabs/store.ts:230,264`)。
5. `src/ui/viewTransition.ts:23-30` 只判断 API 是否存在，随后调用 `document.startViewTransition`，没有非合成渲染路径降级。
6. GDB 从 core 的断言调用指令取出文件和函数字符串：
   - `Source/WebKit/WebProcess/WebPage/CoordinatedGraphics/FrameRenderer.h`
   - `virtual WebCore::GraphicsLayerFactory *WebKit::FrameRenderer::graphicsLayerFactory()`
   - 断言传入行号 0x3f = 63。
   匹配 WebKit 上游 webkitgtk-2.54.1 标签，正是 `RELEASE_ASSERT_NOT_REACHED()`。
7. 因此这是 WebKit 原生进程崩溃，不是 JS 死循环或已证实的 Rust 锁死。JS try/catch 捕获不了此类 SIGABRT。

上游对应源码：
https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.1/Source/WebKit/WebProcess/WebPage/CoordinatedGraphics/FrameRenderer.h#L63

## 独立最小复现

`webkit-startup-probe.c` 只创建原生 WebKitGTK 窗口和 ephemeral context，无 Tauri、Solid、daemon、会话数据和应用 storage。
编译：

```sh
cc artifacts/diagnostics/webkit-startup-probe.c -o artifacts/diagnostics/webkit-startup-probe $(pkg-config --cflags --libs webkit2gtk-4.1)
```

在已有 Wayland 图形会话中执行（建议 `ulimit -c 0`，避免重复生成 core）：

| 条件 | 更新动作 | 实际加速策略 | 结果 |
|---|---|---:|---|
| 默认环境 | 普通 DOM 更新 | 1 | 正常，exit 0 |
| 默认环境 | startViewTransition | 1 | 正常，exit 0 |
| 显式 policy=2 | 普通 DOM 更新 | 2 | 正常，exit 0 |
| 显式 policy=2 | startViewTransition | 2 | 渲染进程崩溃，termination reason=0，exit 2 |
| WEBKIT_DISABLE_DMABUF_RENDERER=1 | 普通 DOM 更新 | 2 | 正常，exit 0 |
| WEBKIT_DISABLE_DMABUF_RENDERER=1 | startViewTransition | 2 | 渲染进程崩溃，termination reason=0，exit 2 |
| WEBKIT_DISABLE_DMABUF_RENDERER=0 | startViewTransition | 1 | 正常，exit 0 |

本机环境：Wayland/KDE，Intel Ivy Bridge 8086:0152，WebKitGTK 2.54.1-1、Mesa 26.2.5-1、GTK 3.24.52-2。
X11 对照未执行成功：缺 X authority，Gtk cannot open display。不能据此声称换 X11 可以修复。

## 为什么看起来无法退出/重开也无效

`src-tauri/src/lib.rs:79-81` 托盘退出只发前端 `app://quit-requested` 事件，等待已崩溃的前端处理确认。
`lib.rs:205-210` 标题栏关闭被改成隐藏窗口，不退出。
`lib.rs:109-114` 单实例插件会把第二次启动转为聚焦旧宿主，而不是新建健康界面。
当前宿主未接管 WebKit 渲染进程崩溃的原生恢复流程。

## 修复方向（尚未修改业务源代码）

优先：对受影响的 Linux WebKitGTK 路径禁用 View Transition，直接执行同步更新；至少尊重性能模式/减少动态效果。不要仅依赖 API 存在性，不要只加 try/catch。
这样保留针对旧核显的 DMA-BUF 规避措施，不必以重新启用问题图形路径为代价。
其次：重新审视 Linux 全机默认禁 DMA-BUF 的策略，按经过测试的环境 opt-in 或显式配置，而非注释宣称的通用安全解法。
宿主增加原生 web-process-terminated 诊断和有界恢复，并提供不依赖 WebView 的安全退出路径（遵守运行中任务退出语义，不能粗暴终止 daemon）。
临时诊断绕过：完全退出旧宿主后用 `WEBKIT_DISABLE_DMABUF_RENDERER=0 ./target/release/qaqh-webui-app`。探针对该变量的效果已验证，但未替用户结束旧宿主或重启实际应用；也未验证恢复 DMA-BUF 后旧显卡的长期稳定性。

## 其他验证

- `pnpm run typecheck`：exit 0。
- `pnpm run test`：53 个测试文件、511 个测试全部通过。存在 Solid SSR SERVER_WRITE 和 Node localStorage 警告。
- `vite.config.ts:44-48` 的测试是 Node 环境，不覆盖 WebKit 原生图形后端，所以绿测不排除此故障。
- 未重启/终止用户的 daemon、桌面宿主或任何会话，未修改业务源代码。
- 本次仅新增诊断探针和此记录；测试生成了 `.tmp/` 缓存。

## 修复落实与验证（后续用户授权）

- 已核对可执行路径并 TERM 终止无响应的 WebUI PID 5209，子进程 5226 随之退出；daemon PID 2337 未动。
- `src/ui/viewTransition.ts` 对 Linux 直接更新，并尊重低配模式与 prefers-reduced-motion；保留 Windows/macOS 正常过渡分支。
- 新增 `tests/view-transition.test.ts`：7 条回归测试。
- 类型检查通过；全量 54 文件、518 测试通过；前端生产构建通过。
- 原生 WebKitGTK 探针加载实际修复后的包装函数，在 `WEBKIT_DISABLE_DMABUF_RENDERER=1`、effective_policy=2 下连续 100 次更新：updates=100、nativeCalls=0、exit=0。
- `cargo build --release --offline -p qaqh-webui-app --features tauri/custom-protocol -j 2` 成功，核验 `target/release/qaqh-webui-app` 已嵌入当前入口 `index-Cg3znenG.js`（入口含 Linux guard）。
- 普通 Cargo 默认构建未嵌入资源，已用上述 custom-protocol 构建覆盖；不要将默认 Cargo 产物误作桌面发行构建。
- 本地后端 path crates 版本是 2.0.0，Cargo 在构建时将锁文件中 7 个 RC2 条目更新为 2.0.0。该无关锁文件变更已恢复，业务修复不包含依赖版本调整。
- 未启动修复后的实际应用，以免自动 attach 抢占当前会话 active seat。实际窗口交互仍需启动后验收；原生后端与资源嵌入验证已完成。
