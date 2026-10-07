import type { Component } from "solid-js";
import IconBlocks from "~icons/lucide/blocks";

export const ToolsPage: Component = () => (
  <div class="tools-page">
    <header class="tools-page-head">
      <h1>工具</h1>
      <p>管理可供会话调用的 skills 与扩展。</p>
    </header>
    <section class="tools-empty" aria-labelledby="tools-empty-title">
      <span class="tools-empty-icon" aria-hidden="true"><IconBlocks /></span>
      <h2 id="tools-empty-title">工具面板正在准备中</h2>
      <p>Skills 商店和已安装工具会集中显示在这里。</p>
    </section>
  </div>
);
