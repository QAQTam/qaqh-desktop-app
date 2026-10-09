//! 界面进程组与壳自身读数:桌面端「本机内存」的两条系统侧来源。
//!
//! 为什么不能只看壳进程:页面根本不在壳进程里。WebView2(Win)会另起 browser /
//! renderer / GPU / utility 一组进程,WKWebView(mac)会另起
//! `com.apple.WebKit.WebContent` / `.Networking` / `.GPU`。缺了这一块,「这软件吃
//! 多少内存」的答案就永远少掉最大的一块。
//!
//! 两条来源的口径差别:
//!  - **Windows**:身份问引擎(`ICoreWebView2Environment8::GetProcessInfos` 给 PID +
//!    Kind),字节量问 OS(psapi 逐进程)。逐进程 `MemoryUsage` **不在 COM 面上**
//!    (0.39.1 绑定里 14 处 `MemoryUsage` 全是 `ICoreWebView2_19` 的
//!    `MemoryUsageTargetLevel`,那是设置上报级别的开关,不是读数),所以只能这么拼。
//!  - **macOS**:没有引擎侧进程清单可问,只能枚举自己的子进程
//!    (`proc_listchildpids`),角色退化成按可执行路径认;字节量一律用
//!    `proc_pid_rusage` 的 `ri_phys_footprint`——那是活动监视器「内存」列的口径,
//!    和用户在其他地方看到的数对得上。它**不等于** Windows 的工作集,两边别横着比。
//!  - **Linux**:未实现(做法与 mac 同形:扫 `/proc/*/status` 的 `PPid` + 取 `VmRSS`)。
//!
//! 一条通用纪律:某个进程读不到(权限/沙箱/已退出)**不静默跳过**——成员照样列出,
//! `resident_bytes` 留 null 并把错误文本带上,让 UI 显示「—」而不是悄悄少加一块。
use serde::Serialize;

#[derive(Serialize)]
pub struct GroupMember {
    pub pid: i32,
    /// 角色标签:Windows 由引擎自报,mac 按可执行路径认。
    pub kind: &'static str,
    pub resident_bytes: Option<u64>,
    /// mac 没有与 Windows「私有提交页」对应的口径,一律 null。
    pub private_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ProcessGroup {
    /// 读数来源;不支持的目标是 `unsupported`。
    pub source: &'static str,
    pub error: Option<String>,
    pub members: Vec<GroupMember>,
}

/// 一次成员读数。装配只走 `assemble_group` 一个口子,免得哪个平台忘了「失败要留痕」。
pub(crate) struct MemberRead {
    pub pid: i32,
    pub kind: &'static str,
    pub resident: Option<u64>,
    pub private: Option<u64>,
    pub error: Option<String>,
}

fn unsupported(reason: Option<String>) -> ProcessGroup {
    ProcessGroup {
        source: "unsupported",
        error: reason,
        members: Vec::new(),
    }
}

fn assemble_group(source: &'static str, reads: Vec<MemberRead>) -> ProcessGroup {
    ProcessGroup {
        source,
        error: None,
        members: reads
            .into_iter()
            .map(|read| GroupMember {
                pid: read.pid,
                kind: read.kind,
                resident_bytes: read.resident,
                private_bytes: read.private,
                error: read.error,
            })
            .collect(),
    }
}

/// 按可执行路径认角色(mac / linux 用;Windows 走引擎自报的 Kind)。
///
/// 只认 WebKit 那三个已知 helper,其余归 `other`——宁可标粗,也不要按进程名猜一个
/// 看着像但其实不对的角色。
///
/// `test` 也编译它:纯函数,单测在非 mac 目标上照样能覆盖这条归类规则。
#[cfg(any(test, target_os = "macos"))]
fn kind_label_of_path(path: &str) -> &'static str {
    if path.contains("com.apple.WebKit.WebContent") {
        "renderer"
    } else if path.contains("com.apple.WebKit.Networking") {
        "network"
    } else if path.contains("com.apple.WebKit.GPU") {
        "gpu"
    } else {
        "other"
    }
}

/// 壳自己这个进程的内存计数。
///
/// macOS 上 `qaqh-memwatch` 没有实现(它的 fallback 分支直接返回 `unsupported`),
/// 所以这里用与进程组同一个 `phys_footprint` 口径自己读——否则 mac 的「本机」面板
/// 第一行永远是空的。其余目标交给 memwatch(内部就是 psapi / procfs),字段与
/// daemon 的 `diagnostics.memory.process` 同形,前端才能拼一张表。
#[cfg(target_os = "macos")]
pub(crate) fn shell_process_memory() -> qaqh_memwatch::ProcessMemory {
    match footprint(std::process::id() as libc::c_int) {
        Ok(bytes) => qaqh_memwatch::ProcessMemory {
            resident_bytes: Some(bytes),
            source: "mac.rusage.phys_footprint",
            ..Default::default()
        },
        Err(reason) => qaqh_memwatch::ProcessMemory {
            source: "mac.rusage",
            error: Some(reason),
            ..Default::default()
        },
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn shell_process_memory() -> qaqh_memwatch::ProcessMemory {
    qaqh_memwatch::global().snapshot().process
}

/// 非 Windows、非 macOS:没有进程清单实现,显式缺。
#[cfg(not(any(windows, target_os = "macos")))]
pub async fn collect(_app: &tauri::AppHandle) -> ProcessGroup {
    unsupported(Some(
        "process group counters are not implemented for this target".to_string(),
    ))
}

#[cfg(windows)]
pub async fn collect(app: &tauri::AppHandle) -> ProcessGroup {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return unsupported(Some("no_main_window".to_string()));
    };
    // WebView2 的 COM 对象是套间线程化的,只能在 UI 线程上问;`with_webview` 就是
    // 把闭包投递过去,结果用 oneshot 接回来。投递失败(窗口正在销毁等)时闭包根本
    // 不会跑——不接这个 Result,下面的 `rx.await` 就是永久挂起。
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<(i32, &'static str)>, String>>();
    if let Err(cause) = window.with_webview(move |web| {
        let listed = list_processes(&web.environment());
        let _ = tx.send(listed);
    }) {
        return unsupported(Some(format!("with_webview failed: {cause}")));
    }
    let listed = match rx.await {
        Ok(value) => value,
        Err(_) => return unsupported(Some("webview_thread_dropped".to_string())),
    };
    let reads = match listed {
        Ok(entries) => entries
            .into_iter()
            .map(|(pid, kind)| read_one(pid, kind))
            .collect(),
        Err(reason) => return unsupported(Some(reason)),
    };
    assemble_group("webview2.pids+psapi", reads)
}

#[cfg(target_os = "macos")]
pub async fn collect(_app: &tauri::AppHandle) -> ProcessGroup {
    // daemon 是壳的**子进程**,不剔掉就会和「daemon 进程」那一行重复计数。
    let daemon = daemon_pid();
    let reads = child_pids(std::process::id() as libc::c_int)
        .into_iter()
        .filter(|pid| Some(*pid) != daemon)
        .map(|pid| {
            let kind = kind_label_of_path(&path_of(pid));
            match footprint(pid) {
                Ok(bytes) => MemberRead {
                    pid,
                    kind,
                    resident: Some(bytes),
                    private: None,
                    error: None,
                },
                Err(reason) => MemberRead {
                    pid,
                    kind,
                    resident: None,
                    private: None,
                    error: Some(reason),
                },
            }
        })
        .collect();
    assemble_group("mac.libproc+rusage", reads)
}

/// 问引擎要进程清单。返回 `(pid, kind)`;运行时拿不到 `Environment8` 时报错。
#[cfg(windows)]
fn list_processes(
    environment: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
) -> Result<Vec<(i32, &'static str)>, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_KIND_BROWSER, ICoreWebView2Environment8,
    };
    use windows_core::Interface;

    let environment8 = environment
        .clone()
        .cast::<ICoreWebView2Environment8>()
        .map_err(|cause| format!("ICoreWebView2Environment8 unavailable: {cause}"))?;
    // SAFETY: GetProcessInfos / Count / GetValueAtIndex / ProcessId / Kind 都是
    // COM 虚表调用,`environment8` 是有效接口对象;所有出参都是本地可写变量,
    // 且紧跟一次 HRESULT 检查才使用。
    let collection = unsafe { environment8.GetProcessInfos() }
        .map_err(|cause| format!("GetProcessInfos failed: {cause}"))?;
    let mut count: u32 = 0;
    unsafe { collection.Count(&mut count) }
        .map_err(|cause| format!("ProcessInfoCollection.Count failed: {cause}"))?;
    let mut out = Vec::with_capacity(count as usize);
    for index in 0..count {
        // SAFETY: 同上;index 在 Count 范围内。
        let info = match unsafe { collection.GetValueAtIndex(index) } {
            Ok(info) => info,
            Err(_) => continue,
        };
        let mut pid: i32 = 0;
        let mut kind = COREWEBVIEW2_PROCESS_KIND_BROWSER;
        // SAFETY: 同上。
        if unsafe { info.ProcessId(&mut pid).is_err() } {
            continue;
        }
        // SAFETY: 同上。
        let kind_ok = unsafe { info.Kind(&mut kind) }.is_ok();
        let label = if kind_ok {
            kind_label_of(&kind)
        } else {
            "unknown"
        };
        out.push((pid, label));
    }
    Ok(out)
}

#[cfg(windows)]
fn kind_label_of(
    kind: &webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_KIND,
) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_KIND_GPU, COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER,
        COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN, COREWEBVIEW2_PROCESS_KIND_RENDERER,
        COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER, COREWEBVIEW2_PROCESS_KIND_UTILITY,
    };
    if *kind == COREWEBVIEW2_PROCESS_KIND_RENDERER {
        "renderer"
    } else if *kind == COREWEBVIEW2_PROCESS_KIND_GPU {
        "gpu"
    } else if *kind == COREWEBVIEW2_PROCESS_KIND_UTILITY {
        "utility"
    } else if *kind == COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER {
        "sandbox_helper"
    } else if *kind == COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN {
        "ppapi_plugin"
    } else if *kind == COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER {
        "ppapi_broker"
    } else {
        "browser"
    }
}

/// 逐进程读工作集与私有提交页。
#[cfg(windows)]
fn read_one(pid: i32, kind: &'static str) -> MemberRead {
    match process_memory_bytes(pid) {
        Ok((resident, private)) => MemberRead {
            pid,
            kind,
            resident: Some(resident),
            private: Some(private),
            error: None,
        },
        Err(reason) => MemberRead {
            pid,
            kind,
            resident: None,
            private: None,
            error: Some(reason),
        },
    }
}

#[repr(C)]
#[cfg(windows)]
struct MemoryCountersEx {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_usage: usize,
}

/// `PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ`。
/// 后者是 `GetProcessMemoryInfo` 读工作集所要求的权限(Win8.1+ 文档口径)。
#[cfg(windows)]
const PROCESS_ACCESS: u32 = 0x1000 | 0x0010;

#[cfg(windows)]
fn process_memory_bytes(pid: i32) -> Result<(u64, u64), String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(
            desired_access: u32,
            inherit_handle: i32,
            process_id: u32,
        ) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut MemoryCountersEx,
            size: u32,
        ) -> i32;
    }

    let mut counters = MemoryCountersEx {
        cb: std::mem::size_of::<MemoryCountersEx>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
        private_usage: 0,
    };
    // SAFETY: 句柄非 NULL 才继续;`counters` 的 C 布局与
    // PROCESS_MEMORY_COUNTERS_EX 一致,且 `cb` 已按实际大小填好。
    unsafe {
        let handle = OpenProcess(PROCESS_ACCESS, 0, pid as u32);
        if handle.is_null() {
            return Err(format!(
                "OpenProcess({pid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb);
        let error = std::io::Error::last_os_error();
        CloseHandle(handle);
        if ok == 0 {
            return Err(format!("GetProcessMemoryInfo({pid}) failed: {error}"));
        }
    }
    Ok((
        counters.working_set_size as u64,
        counters.private_usage as u64,
    ))
}

/// sidecar daemon 的 PID;读不到 discovery 就返回 None(那就无从剔除)。
#[cfg(target_os = "macos")]
fn daemon_pid() -> Option<libc::c_int> {
    qaqh_client::read_discovery()
        .ok()
        .map(|discovery| discovery.pid as libc::c_int)
}

#[cfg(target_os = "macos")]
fn child_pids(parent: libc::c_int) -> Vec<libc::c_int> {
    const ENTRY: usize = std::mem::size_of::<i32>();
    let mut capacity: usize = 64;
    loop {
        let mut buffer = vec![0i32; capacity];
        let room = (buffer.len() * ENTRY) as libc::c_int;
        // SAFETY: 传出的字节数与 `buffer` 的实际容量一致,内核只往里写 i32。
        let written = unsafe {
            libc::proc_listchildpids(parent, buffer.as_mut_ptr() as *mut libc::c_void, room)
        };
        if written <= 0 {
            return Vec::new();
        }
        let bytes = written as usize;
        buffer.truncate((bytes / ENTRY).min(buffer.len()));
        // 没写满就是全量;写满了就扩容再问一次(兜底上限 4096 条子进程)。
        if bytes < room as usize || capacity > 4096 {
            return buffer;
        }
        capacity *= 4;
    }
}

#[cfg(target_os = "macos")]
fn path_of(pid: libc::c_int) -> String {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: 容量按 `PROC_PIDPATHINFO_MAXSIZE` 给,内核写入不会越界。
    let written = unsafe {
        libc::proc_pidpath(
            pid,
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as u32,
        )
    };
    if written <= 0 {
        return String::new();
    }
    let end = buffer[..written as usize]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(written as usize);
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

/// `ri_phys_footprint`:活动监视器「内存」列那个数。
#[cfg(target_os = "macos")]
fn footprint(pid: libc::c_int) -> Result<u64, String> {
    // SAFETY: 全零起步;`rusage_info_v4` 是 POD,内核按 flavor 写满整个结构体。
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    // libc 把 `rusage_info_t` 声明成 `*mut c_void`,于是这个参数类型就成了
    // `*mut *mut c_void`;内核要的是结构体地址本身,所以直接转过去。
    let code = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V4,
            &mut info as *mut libc::rusage_info_v4 as *mut libc::rusage_info_t,
        )
    };
    if code != 0 {
        return Err(format!(
            "proc_pid_rusage({pid}) failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(info.ri_phys_footprint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webkit_helpers_are_named_by_path() {
        assert_eq!(
            kind_label_of_path(
                "/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"
            ),
            "renderer"
        );
        assert_eq!(
            kind_label_of_path(
                "…/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking"
            ),
            "network"
        );
        assert_eq!(kind_label_of_path("…/com.apple.WebKit.GPU.xpc"), "gpu");
        // 认不出来就老实标 other,不猜一个看着像的角色。
        assert_eq!(
            kind_label_of_path("/Applications/QAQH.app/Contents/MacOS/qaqh-helper"),
            "other"
        );
        assert_eq!(kind_label_of_path(""), "other");
    }

    #[test]
    fn failed_members_are_kept_with_their_reason() {
        let group = assemble_group(
            "mac.libproc+rusage",
            vec![
                MemberRead {
                    pid: 1,
                    kind: "renderer",
                    resident: Some(40),
                    private: None,
                    error: None,
                },
                MemberRead {
                    pid: 2,
                    kind: "gpu",
                    resident: None,
                    private: None,
                    error: Some("proc_pid_rusage(2) failed: 拒绝访问".to_string()),
                },
            ],
        );
        assert_eq!(group.source, "mac.libproc+rusage");
        assert_eq!(group.members.len(), 2);
        assert_eq!(group.members[1].resident_bytes, None);
        assert!(group.members[1].error.is_some());
    }

    #[test]
    fn mac_members_have_no_private_reading() {
        // mac 口径里没有与 Windows「私有提交页」对应的量:必须是 None,不能拿
        // footprint 冒充,否则前端那一列会给出一个不存在的对比。
        let group = assemble_group(
            "mac.libproc+rusage",
            vec![MemberRead {
                pid: 7,
                kind: "renderer",
                resident: Some(123),
                private: None,
                error: None,
            }],
        );
        assert_eq!(group.members[0].resident_bytes, Some(123));
        assert_eq!(group.members[0].private_bytes, None);
    }
}
