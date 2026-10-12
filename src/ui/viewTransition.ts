/**
 * 视图过渡包装(same-document View Transitions)。
 *
 * 用在哪:标签/会话切换这类「整块内容换血」的同步信号写入(activateTab /
 * openStartup)。之前是硬切;现在旧状态快照与新状态做一次交叉淡出。
 *
 * 引擎面:WebView2(Chromium 111+)与 macOS WKWebView(Safari 18+)都支持;
 * 其余(浏览器预览的旧内核)自动退回直接更新,调用方无感。
 *
 * 关键点:`startViewTransition` 的回调是**异步**执行的(浏览器把它排到下一帧的
 * 渲染更新里),所以回调里的信号写入**不会**在本次同步代码里可见。里面用 flush()
 * 把 Solid 2 排队的写入当场排干,只是为了让「新」快照捕获到写入后的状态 —— 它
 * 不能让写入对调用方同步可见。**调用方不得在同一 tick 里读这些信号**:需要「同步
 * 知道结果」的状态(如「当前要激活哪张标签」)要另有同步来源,否则会读到旧值。
 * 回调不要包 await:挂期间的 attach/RPC 会拖住旧快照冻屏。
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
