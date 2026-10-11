/**
 * 视图过渡包装(same-document View Transitions)。
 *
 * 用在哪:标签/会话切换这类「整块内容换血」的同步信号写入(activateTab /
 * openStartup)。之前是硬切;现在旧状态快照与新状态做一次交叉淡出。
 *
 * 引擎面:WebView2(Chromium 111+)与 macOS WKWebView(Safari 18+)都支持;
 * 其余(浏览器预览的旧内核)自动退回直接更新,调用方无感。
 *
 * 关键点:startViewTransition 的回调必须**同步**完成 DOM 换血 —— Solid 2 的
 * 写入是排队的,这里用 flush() 把队列当场排干,保证「新」快照捕获到的是
 * 写入后的状态。回调不要包 await:挂期间的 attach/RPC 会拖住旧快照冻屏。
 */
import { flush } from "solid-js";

type VtDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => unknown };

export function withViewTransition(update: () => void): void {
  const doc = document as VtDocument;
  if (typeof doc.startViewTransition !== "function") {
    update();
    return;
  }
  doc.startViewTransition(() => {
    update();
    flush();
  });
}
