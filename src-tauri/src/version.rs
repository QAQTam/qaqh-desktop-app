//! 壳自身的构建标识:版本 + git commit,喂给设置页「关于」。
//!
//! 版本单源是 `[workspace.package] version`(`CARGO_PKG_VERSION`),commit 由
//! `build.rs` 注入。这里**不**掺 daemon 版本——那是后端仓的产物,「关于」要回答的
//! 问题是「我装的这个壳是哪一次构建」。

use serde_json::{Value, json};

#[tauri::command]
pub fn app_version() -> Value {
    let version = env!("CARGO_PKG_VERSION");
    let commit = env!("QAQH_GIT_COMMIT");
    json!({
        "version": version,
        "commit": commit,
        "display": format!("{version}-{commit}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_joins_version_and_commit() {
        let info = app_version();
        let version = env!("CARGO_PKG_VERSION");
        let commit = env!("QAQH_GIT_COMMIT");
        assert_eq!(info["version"], version);
        assert_eq!(
            info["display"],
            format!("{version}-{commit}"),
            "「关于」显示的是这两段拼出来的,分开漂移就没意义了"
        );
    }
}
