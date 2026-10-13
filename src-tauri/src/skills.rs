//! 用户级 skills 扫描(宿主侧)。
//!
//! **为什么在宿主里扫**:daemon 的 `fs.list`/`fs.read` 白名单是「数据根 + UI 注册
//! 工作区 + 会话 cwd」(`qaqh-backend/crates/qaqh-runtime/src/service/fs_git.rs:28-51`),
//! 用户级 skill 根(`~/.qaqh/skills`、`~/.agents/skills`)不在其中——渲染层拿不到。
//! daemon 自己扫得到(`qaqh-backend/crates/qaqh-skills/src/lib.rs:195-207` 的
//! discovery roots),但那份 catalog 只经 Ringing 控制事件 `SkillsUpdated` 出去,
//! 该事件在 v2 投影里没有对应 fact(`ringing/pending_store.rs:310`:v1 的
//! `SkillsUpdated` / `OperationCompleted` 在 fact 侧无一比一对应物),webview 收不到。
//! 于是宿主按同一份规则把用户级那两层读出来交给渲染层。
//!
//! **边界**:命令不接受任何路径参数——扫哪些根由宿主自己算(`home_dir()` 下的两个
//! 固定目录),渲染层无法用它读任意文件。回给 webview 的只有这两个根下的
//! `SKILL.md` 正文。
//!
//! 规则逐条对齐 `qaqh-skills`,不另立一套:
//!  - 根与优先级:`~/.qaqh/skills` > `~/.agents/skills`(同名先到先得);
//!  - 递归深度 ≤ [`MAX_SCAN_DEPTH`],跳过 `.` 开头目录与 `node_modules`/`target`;
//!  - 目录直接含 `SKILL.md` 即算一个 skill;
//!  - 单文件 ≤ [`MAX_SKILL_BYTES`]、目录数 ≤ [`MAX_SCANNED_DIRS`]、
//!    skill 数 ≤ [`MAX_SKILLS`](`qaqh-skills/src/lib.rs:27-30`)。

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// 与 `qaqh-skills/src/lib.rs:28` 的 `MAX_SCAN_DEPTH` 同值。
const MAX_SCAN_DEPTH: usize = 6;
/// 与 `qaqh-skills/src/lib.rs:29` 的 `MAX_SCANNED_DIRS` 同值。
const MAX_SCANNED_DIRS: usize = 2_000;
/// 与 `qaqh-skills/src/lib.rs:30` 的 `MAX_SKILLS` 同值。
const MAX_SKILLS: usize = 256;
/// 与 `qaqh-skills/src/lib.rs:27` 的 `MAX_SKILL_BYTES` 同值。
const MAX_SKILL_BYTES: u64 = 512 * 1024;
/// 一次回给 webview 的正文字节预算。用户级 skill 都是几 KB 量级,这条只是防
/// 「home 下塞了几百 MB」把 IPC 撑爆;超出部分按诊断列出而不是静默丢弃。
const MAX_INLINE_BYTES: u64 = 8 * 1024 * 1024;

/// 一个用户级发现根(展示用)。
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct UserRootWire {
    /// 绝对路径。
    path: String,
    /// `~/.agents/skills` 形态的展示标签。
    label: String,
    /// 目录存在且可读。
    exists: bool,
}

/// 一条用户级 skill 的原始文件(解析交给渲染层的 `skills/parse.ts`)。
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct UserSkillWire {
    /// 发现它的根(绝对路径)。
    root: String,
    /// `SKILL.md` 绝对路径。
    path: String,
    /// 正文(CRLF 已归一,与 `qaqh-skills` 的 `read_bounded` 同形)。
    content: String,
    bytes: u64,
}

/// 扫描过程中的非致命问题(目录不可读、文件超限、预算用尽)。
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct UserDiagnosticWire {
    path: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct UserScanWire {
    roots: Vec<UserRootWire>,
    skills: Vec<UserSkillWire>,
    diagnostics: Vec<UserDiagnosticWire>,
}

/// 平台 home。`qaqh_types::platform::home_dir` 在环境缺失时返回空 PathBuf,
/// 这里把它折成 `None`(空路径 join 出来的根没有意义)。
fn home_dir() -> Option<PathBuf> {
    let home = qaqh_types::platform::home_dir();
    (!home.as_os_str().is_empty()).then_some(home)
}

/// 用户级发现根,顺序即优先级(`qaqh-skills/src/lib.rs:202-205`)。
fn user_roots(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".qaqh/skills"), home.join(".agents/skills")]
}

/// 展示标签:相对 home 的 `~/…` 形态,分隔符统一成 `/`(与渲染层的展示一致)。
fn label_for(root: &Path, home: &Path) -> String {
    let relative = root.strip_prefix(home).unwrap_or(root);
    format!("~/{}", text(relative).replace('\\', "/"))
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// 与 `qaqh-skills` 的 `should_skip_dir` 同规则(点开头已覆盖 `.git`)。
fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target")
}

/// 用户级 skills 全量扫描。`home` 可注入是为了单测不依赖真实 `USERPROFILE`。
fn scan(home: Option<&Path>) -> UserScanWire {
    let mut roots: Vec<UserRootWire> = Vec::new();
    let mut skills: Vec<UserSkillWire> = Vec::new();
    let mut diagnostics: Vec<UserDiagnosticWire> = Vec::new();
    let Some(home) = home else {
        return UserScanWire {
            roots,
            skills,
            diagnostics,
        };
    };
    let mut budget = ScanBudget {
        scanned_dirs: 0,
        inline_bytes: 0,
    };
    for root in user_roots(home) {
        let exists = root.is_dir();
        if exists {
            walk(&root, &root, &mut skills, &mut diagnostics, &mut budget);
        }
        roots.push(UserRootWire {
            path: text(&root),
            label: label_for(&root, home),
            exists,
        });
    }
    UserScanWire {
        roots,
        skills,
        diagnostics,
    }
}

struct ScanBudget {
    scanned_dirs: usize,
    inline_bytes: u64,
}

/// 迭代式目录遍历(与 `qaqh-skills::scan_root` 的栈序、深度、跳过规则一致)。
///
/// 不可读的目录出诊断(与 daemon 的 `scan_root` 同行为),而不是静默跳过——
/// 用户级根常因权限问题半读,静默会让「少了一个 skill」无从解释。
fn walk(
    root: &Path,
    dir: &Path,
    skills: &mut Vec<UserSkillWire>,
    diagnostics: &mut Vec<UserDiagnosticWire>,
    budget: &mut ScanBudget,
) {
    let mut stack: Vec<(PathBuf, usize)> = vec![(dir.to_path_buf(), 0)];
    while let Some((current, depth)) = stack.pop() {
        if budget.scanned_dirs >= MAX_SCANNED_DIRS || skills.len() >= MAX_SKILLS {
            diagnostics.push(UserDiagnosticWire {
                path: text(&current),
                message: format!(
                    "scan truncated at {} directories / {} skills",
                    MAX_SCANNED_DIRS, MAX_SKILLS
                ),
            });
            return;
        }
        budget.scanned_dirs += 1;
        let mut entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(error) => {
                diagnostics.push(UserDiagnosticWire {
                    path: text(&current),
                    message: format!("cannot scan directory: {error}"),
                });
                continue;
            }
        };
        entries.sort_by_key(|entry| entry.file_name());
        entries.reverse();
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() || skip_dir(&name) {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if skill_file.is_file() {
                read_skill(root, &skill_file, skills, diagnostics, budget);
            }
            if depth < MAX_SCAN_DEPTH {
                stack.push((path, depth + 1));
            }
        }
    }
}

fn read_skill(
    root: &Path,
    path: &Path,
    skills: &mut Vec<UserSkillWire>,
    diagnostics: &mut Vec<UserDiagnosticWire>,
    budget: &mut ScanBudget,
) {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            diagnostics.push(UserDiagnosticWire {
                path: text(path),
                message: format!("cannot stat skill file: {error}"),
            });
            return;
        }
    };
    if metadata.len() > MAX_SKILL_BYTES {
        diagnostics.push(UserDiagnosticWire {
            path: text(path),
            message: format!("skill file exceeds {MAX_SKILL_BYTES} bytes"),
        });
        return;
    }
    if budget.inline_bytes.saturating_add(metadata.len()) > MAX_INLINE_BYTES {
        diagnostics.push(UserDiagnosticWire {
            path: text(path),
            message: format!("inline budget exceeded ({MAX_INLINE_BYTES} bytes)"),
        });
        return;
    }
    match std::fs::read_to_string(path) {
        Ok(content) => {
            budget.inline_bytes += metadata.len();
            skills.push(UserSkillWire {
                root: text(root),
                path: text(path),
                content: content.replace("\r\n", "\n").replace('\r', "\n"),
                bytes: metadata.len(),
            });
        }
        Err(error) => diagnostics.push(UserDiagnosticWire {
            path: text(path),
            message: format!("cannot read skill: {error}"),
        }),
    }
}

/// `() → UserScanWire`。扫 `~/.qaqh/skills` 与 `~/.agents/skills`。
///
/// 同步读盘放进 `spawn_blocking`:目录遍历是阻塞 IO,别占 IPC 的 async worker。
#[tauri::command]
pub async fn skills_user_scan() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        serde_json::to_value(scan(home_dir().as_deref())).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("skills_user_scan 任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时 home;同名目录先清掉,免得上一次跑剩的文件混进来。
    fn temp_home(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qaqh-user-skills-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时 home");
        dir
    }

    fn write_skill(dir: &Path, name: &str, description: &str) {
        let skill_dir = dir.join(name);
        std::fs::create_dir_all(&skill_dir).expect("建 skill 目录");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nbody\n"),
        )
        .expect("写 SKILL.md");
    }

    #[test]
    fn user_roots_are_qaqh_then_agents() {
        let home = Path::new("C:/Users/tester");
        let roots = user_roots(home);
        let expected = [home.join(".qaqh/skills"), home.join(".agents/skills")];
        assert_eq!(
            roots,
            expected.to_vec(),
            "顺序即优先级:同名 skill 先到先得(qaqh-skills/src/lib.rs:202-205)"
        );
    }

    #[test]
    fn labels_are_tilde_relative_with_forward_slashes() {
        let home = Path::new("C:/Users/tester");
        assert_eq!(
            label_for(&home.join(".agents/skills"), home),
            "~/.agents/skills"
        );
    }

    #[test]
    fn scan_reads_both_roots_recursively_and_skips_hidden_dirs() {
        let home = temp_home("walk");
        write_skill(&home.join(".agents/skills"), "alpha", "Alpha workflow.");
        write_skill(&home.join(".qaqh/skills"), "beta", "Beta workflow.");
        // 嵌套:daemon 的 scan_root 会下潜,UI 必须看到同一个 skill。
        write_skill(&home.join(".agents/skills/group"), "nested", "Nested.");
        // 点开头目录不下潜;node_modules 同理。
        write_skill(&home.join(".agents/skills/.hidden"), "ghost", "Hidden.");
        write_skill(
            &home.join(".agents/skills/node_modules"),
            "vendored",
            "Vendored.",
        );

        let out = scan(Some(&home));
        let mut names: Vec<String> = out
            .skills
            .iter()
            .map(|skill| {
                Path::new(&skill.path)
                    .parent()
                    .and_then(Path::file_name)
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .collect();
        names.sort();
        assert_eq!(names, vec!["alpha", "beta", "nested"]);

        // 每条都带自己的根,渲染层据此分桶。
        let alpha = out
            .skills
            .iter()
            .find(|skill| skill.path.contains("alpha"))
            .expect("alpha 在结果里");
        assert_eq!(alpha.root, text(&home.join(".agents/skills")));
        assert!(alpha.content.contains("Alpha workflow."));
        assert_eq!(out.roots.len(), 2);
        assert!(out.roots.iter().all(|root| root.exists));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn scan_reports_oversized_skill_and_missing_root() {
        let home = temp_home("limits");
        let dir = home.join(".agents/skills/big");
        std::fs::create_dir_all(&dir).expect("建 skill 目录");
        let oversized = "x".repeat((MAX_SKILL_BYTES + 1) as usize);
        std::fs::write(dir.join("SKILL.md"), oversized).expect("写超限文件");

        let out = scan(Some(&home));
        assert!(out.skills.is_empty(), "超限文件不进列表");
        assert!(
            out.diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains("exceeds")),
            "超限要出诊断而不是静默丢弃"
        );
        // `.qaqh/skills` 不存在:标 exists=false,不产生噪声诊断。
        let missing = out
            .roots
            .iter()
            .find(|root| root.label == "~/.qaqh/skills")
            .expect("qaqh 根在列表里");
        assert!(!missing.exists);

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn scan_without_home_returns_empty_shape() {
        let out = scan(None);
        assert!(out.roots.is_empty());
        assert!(out.skills.is_empty());
        assert!(out.diagnostics.is_empty());
    }
}
