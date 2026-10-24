// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK 2.42+ 的 DMA-BUF 硬件加速渲染器在现代 Linux (WebKitGTK 2.54+)
        // 下必须默认保留，以保证基本的 GPU 合成与 View Transition 正常执行。
        // 强制设为 1 会将硬件加速策略降级为 NEVER (2)，导致软光栅 llvmpipe 占用极高 CPU 并触发断言崩溃。
        // 仅在用户显式设置了 QAQH_DISABLE_DMABUF 时才强设环境变量，绝不无条件默认禁用。
        if std::env::var_os("QAQH_DISABLE_DMABUF").is_some() {
            unsafe {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }

    qaqh_webui_app::run()
}
