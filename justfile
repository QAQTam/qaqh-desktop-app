# QAQ-Harness 桌面客户端 —— Tauri 2 壳 + SolidJS 渲染层
#
# daemon 的**权威构建在后端仓**（`../qaqh-backend`）；本仓只负责渲染层构建、
# 壳打包、以及把 daemon 产物搬运成 Tauri sidecar。
#
# 用法: just [recipe]

set windows-shell := ["pwsh.exe", "-NoLogo", "-Command"]

# 前端依赖的后端契约最小点（`DaemonDiscovery.lan_endpoint` / `tls_fingerprint`，
# 即 daemon LAN 双 listener）。src-tauri 用 path 依赖指向 ../qaqh-backend，
# 编译结果跟着那个 worktree 的 checkout 走——所以构建前先断言它在场，
# 别让人对上 8 个 E0609。后端并行分支合流后可以把它往前挪。
BACKEND_CONTRACT_REV := "d454865"

# Intel mac 的产物三元组，显式传而不靠推断：Apple Silicon 上的 Rosetta shell 会把
# host tuple 报成 x86_64，反过来原生 arm64 的 sidecar 在 Intel 机器上装不上——
# 两种情况下报错都出现在打包之后，这里钉死最省事。macOS 26(Tahoe) 是最后一个
# 支持 x86_64 的大版本，所以这条路径要一直留到它退出生命周期。
MAC_X64_TARGET := "x86_64-apple-darwin"

default:
    @just --list

# ── 渲染层 ────────────────────────────────────────────

# 安装依赖 + 静态检查 + 单测 + vite build（产物 out/renderer/）。
renderer-build:
    pnpm install --frozen-lockfile
    pnpm run typecheck
    pnpm run test
    pnpm run build

# ── 质量闸（提交前）──────────────────────────────────
#
# 闸的存在理由：c0faf11 带着 20 个 tsc 错误进了主干（只跑了 vite build），
# 而 solid rc 升级把 classList / keyed For 的形态改了——类型不过=运行时也不对。

# 渲染层闸：类型 + 单测 + 构建。`.githooks/pre-commit` 跑的就是它。
check:
    pnpm run typecheck
    pnpm run test
    pnpm run build

# 前置：src-tauri/binaries/ 里得有**当前三元组**的 sidecar（build.rs 断言），缺了先跑
#   cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon && just place-sidecar debug
# Intel mac 上三条命令都要带 x86_64-apple-darwin，写法见 README「Intel macOS(x86_64)」。
# 壳侧闸：rustfmt + clippy（-D warnings，含 workspace 的 unwrap_used deny）+ 单测。
check-shell:
    cargo fmt --check --manifest-path src-tauri/Cargo.toml
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    cargo test --manifest-path src-tauri/Cargo.toml

# 两条闸一起跑。
gate: check check-shell

# ── 类型契约（唯一的跨仓生成物）──────────────────────
#
# `src/api/qaqh/*.ts` 是**生成物**：由后端仓 crate 上的 `derive(TS)` 导出。
# 生成动作必须在后端仓跑（要 cargo + 那几个 crate 的 ts feature），
# 本仓只把 `TS_RS_EXPORT_DIR` 指到自己的 `src/api/`。
# 本仓以 **pnpm** 为唯一包管理器：只认 pnpm-lock.yaml，不保留第二份锁文件。

[unix]
ts-export:
    cd ../qaqh-backend && TS_RS_EXPORT_DIR="{{justfile_directory()}}/src/api" TS_RS_LARGE_INT=number cargo test -p qaqh-types -p qaqh-domain -p qaqh-ringing -p qaqh-session -p qaqh-config-api --features qaqh-types/ts,qaqh-domain/ts,qaqh-ringing/ts,qaqh-session/ts,qaqh-config-api/ts

[windows]
ts-export:
    $env:TS_RS_EXPORT_DIR="{{justfile_directory()}}/src/api"; $env:TS_RS_LARGE_INT="number"; Push-Location ../qaqh-backend; cargo test -p qaqh-types -p qaqh-domain -p qaqh-ringing -p qaqh-session -p qaqh-config-api --features qaqh-types/ts,qaqh-domain/ts,qaqh-ringing/ts,qaqh-session/ts,qaqh-config-api/ts; Pop-Location

# 生成物落后于 Rust 真相则失败——wire 类型改完忘了跑 ts-export 的兜底。
ts-check: ts-export
    git diff --exit-code src/api

# ── 桌面壳 ────────────────────────────────────────────

# 分两个 OS 变体：macOS/Linux 不自带 pwsh，ps1 在那两个平台是死路。
# 缺 sidecar 时先跑:
#   cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon && just place-sidecar debug
# 放置 daemon 产物为 Tauri sidecar；mode: debug|release，target 留空 = 宿主三元组。
[windows]
place-sidecar mode="debug" target="":
    @pwsh -NoLogo -File scripts/place-sidecar.ps1 {{mode}} {{target}}

[unix]
place-sidecar mode="debug" target="":
    @sh scripts/place-sidecar.sh {{mode}} {{target}}

# 断言 ../qaqh-backend 的 HEAD 含指定契约提交；不在场就中止（早于任何长编译）。
verify-backend rev=BACKEND_CONTRACT_REV:
    @echo "assert: ../qaqh-backend HEAD must contain contract {{rev}}"
    git -C ../qaqh-backend merge-base --is-ancestor {{rev}} HEAD
    @echo "ok: contract {{rev}} is present"

# ── 打包新鲜度闸 ──────────────────────────────────────
#
# 存在理由:NSIS 包名钉死在版本号上,而版本长期不 bump——`desktop-build` 里任何一步
# 在打包前失败,上一次的安装包都原地留着、文件名一模一样,"编译了但装上还是旧 UI"
# 在产物层面无法自证。判据与报错见 scripts/build-guard.mjs。

# 打包前:删旧 bundle(没产物就是没成功)+ 断言已安装实例没在跑(exe 被锁则覆盖必败)。
build-pre:
    node scripts/build-guard.mjs pre

# 打包后:核验壳里嵌的是当前 out/renderer 的入口 hash,且安装包不比壳旧。
build-verify:
    node scripts/build-guard.mjs post

# 桌面开发：契约断言 → 后端仓建 daemon(debug) → 放置 sidecar → pnpm tauri dev。
[windows]
desktop-dev:
    just verify-backend
    cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon
    just place-sidecar debug
    pnpm install --frozen-lockfile
    pnpm tauri dev

# 自包含安装包：渲染层闸 + 契约断言 + 清旧包 + daemon(release) + sidecar + tauri build + 核验。
[windows]
desktop-build: renderer-build
    just verify-backend
    just build-pre
    cargo build --manifest-path ../qaqh-backend/Cargo.toml --release -p qaqh-daemon
    just place-sidecar release
    pnpm tauri build
    just build-verify

# 缺了它 cargo 会在长编译中途报 E0463(std not found),前面几百秒的依赖编译全白扔。
# 断言 rustup 装了 Intel mac 的 x86_64-apple-darwin std。
[macos]
verify-mac-target:
    @rustup target list --installed | grep -qx "{{MAC_X64_TARGET}}" || { echo "缺 {{MAC_X64_TARGET}}:跑 rustup target add {{MAC_X64_TARGET}}" >&2; exit 1; }

# 打包目标(.app/.dmg)与最低系统版本来自 src-tauri/tauri.macos.conf.json,Tauri 按
# 三元组自动合并,所以这里不用带 --bundles。
# 桌面开发(Intel mac)：契约 + 三元组断言 → daemon(x86_64) → sidecar → pnpm tauri dev。
[macos]
desktop-dev:
    just verify-backend
    just verify-mac-target
    cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon --target {{MAC_X64_TARGET}}
    just place-sidecar debug {{MAC_X64_TARGET}}
    pnpm install --frozen-lockfile
    pnpm tauri dev --target {{MAC_X64_TARGET}}

# 只要 .app、不想等 .dmg(hdiutil 偶发卡住)时:
#   pnpm tauri build --target x86_64-apple-darwin --bundles app
# 自包含安装包(Intel mac)：渲染层闸 + daemon(release,x86_64) + sidecar + tauri build。
[macos]
desktop-build: renderer-build
    just verify-backend
    just verify-mac-target
    just build-pre
    cargo build --manifest-path ../qaqh-backend/Cargo.toml --release -p qaqh-daemon --target {{MAC_X64_TARGET}}
    just place-sidecar release {{MAC_X64_TARGET}}
    pnpm tauri build --target {{MAC_X64_TARGET}}
    just build-verify
