//! 构建期把 git 短 sha 焊进壳,供 `version::app_version` 与设置页「关于」显示。
//!
//! 为什么需要:版本串从 2.0.0-beta.2 起没动过,而 NSIS 包名又钉死在版本号上,
//! 于是「装完还是旧 UI」从文件名和版本号上都分辨不出是哪一次构建。commit 进版本串后,
//! 壳内一眼可验;`-dirty` 后缀则挡住「拿未提交的工作树当发布版」这种自欺。

use std::process::Command;

fn git(args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

fn main() {
    // build.rs 一旦声明 rerun-if-changed,cargo 就不再监视整个包目录,所以影响版本串
    // 的来源得逐个列全:HEAD 与 loose refs 管 commit 变化,src 管脏标记的时效。
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
    println!("cargo:rerun-if-changed=src");

    let sha = git(&["rev-parse", "--short", "HEAD"]);
    let commit = if sha.is_empty() {
        // 从源码包/浅克隆构建时没有 git:显式留痕,不假装是某个 commit。
        "nogit".to_string()
    } else if git(&["status", "--porcelain"]).is_empty() {
        sha
    } else {
        format!("{sha}-dirty")
    };
    println!("cargo:rustc-env=QAQH_GIT_COMMIT={commit}");

    tauri_build::build();
}
