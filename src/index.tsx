import { render } from "@solidjs/web";
import App from "./app/App";

// Tauri 桌面壳标记:仅用于原生窗口背景与透明 Mica 区域样式(html.tauri)。
if ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null) {
  document.documentElement.classList.add("tauri");
}

render(() => <App />, document.getElementById("root")!);
