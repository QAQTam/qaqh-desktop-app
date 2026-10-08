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

# 壳侧闸：rustfmt + clippy（-D warnings，含 workspace 的 unwrap_used deny）+ 单测。
# 前置：src-tauri/binaries/ 里得有 sidecar（build.rs 断言），缺了先跑
#   cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon && just place-sidecar debug
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

# 把后端仓的 daemon 产物放置为 Tauri sidecar（目标三元组命名）。
# mode: debug | release
[unix]
[windows]
place-sidecar mode="debug":
    @pwsh -NoLogo -File scripts/place-sidecar.ps1 {{mode}}

# 断言 ../qaqh-backend 的 HEAD 含指定契约提交；不在场就中止（早于任何长编译）。
verify-backend rev=BACKEND_CONTRACT_REV:
    @echo "assert: ../qaqh-backend HEAD must contain contract {{rev}}"
    git -C ../qaqh-backend merge-base --is-ancestor {{rev}} HEAD
    @echo "ok: contract {{rev}} is present"

# 桌面开发：契约断言 → 后端仓建 daemon(debug) → 放置 sidecar → pnpm tauri dev。
[windows]
desktop-dev:
    just verify-backend
    cargo build --manifest-path ../qaqh-backend/Cargo.toml -p qaqh-daemon
    just place-sidecar debug
    pnpm install --frozen-lockfile
    pnpm tauri dev

# 自包含安装包：渲染层闸 + 契约断言 + 后端 daemon(release) + sidecar + tauri build。
[windows]
desktop-build: renderer-build
    just verify-backend
    cargo build --manifest-path ../qaqh-backend/Cargo.toml --release -p qaqh-daemon
    just place-sidecar release
    pnpm tauri build
