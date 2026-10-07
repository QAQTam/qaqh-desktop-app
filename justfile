# QAQ-Harness 桌面客户端 —— Tauri 2 壳 + SolidJS 渲染层
#
# daemon 的**权威构建在后端仓**（`../qaqh-backend`）；本仓只负责渲染层构建、
# 壳打包、以及把 daemon 产物搬运成 Tauri sidecar。
#
# 用法: just [recipe]

set windows-shell := ["pwsh.exe", "-NoLogo", "-Command"]

default:
    @just --list

# ── 渲染层 ────────────────────────────────────────────

# 安装依赖 + 静态检查 + 单测 + vite build（产物 out/renderer/）。
renderer-build:
    bun install --frozen-lockfile
    bun run typecheck
    bun run test
    bun run build

# ── 类型契约（唯一的跨仓生成物）──────────────────────
#
# `src/api/qaqh/*.ts` 是**生成物**：由后端仓 crate 上的 `derive(TS)` 导出。
# 生成动作必须在后端仓跑（要 cargo + 那几个 crate 的 ts feature），
# 本仓只把 `TS_RS_EXPORT_DIR` 指到自己的 `src/api/`。
# 若用 pnpm 而非 bun，请保持 lockfile 单一来源——本仓以 bun.lock 为准。

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

# 把后端仓的 daemon 产物放置为 Tauri sidecar（目标三元组命名）。
# mode: debug | release
[unix]
[windows]
place-sidecar mode="debug":
    @pwsh -NoLogo -File scripts/place-sidecar.ps1 {{mode}}

# 桌面开发：后端仓建 daemon(debug) → 放置 sidecar → bun tauri dev。
[windows]
desktop-dev:
    cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon
    just place-sidecar debug
    bun install --frozen-lockfile
    bun tauri dev

# 自包含安装包：渲染层 + 后端 daemon(release) + sidecar + tauri build。
[windows]
desktop-build: renderer-build
    cargo build --manifest-path ../qaqh-backend/Cargo.toml --release -p qaqh-daemon
    just place-sidecar release
    bun tauri build
