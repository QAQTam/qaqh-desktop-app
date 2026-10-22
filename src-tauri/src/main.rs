// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK 2.42+ 的 DMA-BUF 硬件加速渲染器在 Linux 老旧 Intel 核显(Ivy Bridge HD 2500)
        // 配合 Mesa 驱动时存在上游缺陷：窗口缩放时显存缓冲区无法正确同步（产生黑屏边框），
        // 且导致 WebKit 陷入 llvmpipe 软光栅死循环打满 100% CPU。
        // 在 GTK / WebKitGTK 初始化前禁用 DMA-BUF 渲染器是 Tauri 在 Linux 老集显下的官方标准修复。
        // Rust 2024 / rustc 1.80+ 起将修改进程环境变量标定为 unsafe fn；此处在主线程单线程启动初期设置，无并发数据竞争。
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            unsafe {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }

    qaqh_webui_app::run()
}
