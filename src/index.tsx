import { render } from "@solidjs/web";
import App from "./app/App";
import "./lib/typography";

// Tauri 桌面壳标记:仅用于原生窗口背景与透明 Mica 区域样式(html.tauri)。
if ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null) {
  document.documentElement.classList.add("tauri");
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platformStr = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  const isMac = /mac/i.test(platformStr);
  if (isMac) {
    document.documentElement.classList.add("platform-macos");
    document.documentElement.dataset.platform = "macos";
  } else {
    document.documentElement.classList.add("platform-windows");
    document.documentElement.dataset.platform = "windows";
  }
}

render(() => <App />, document.getElementById("root")!);
