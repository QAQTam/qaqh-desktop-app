/**
 * 「关于」:桌面壳自身的构建标识(版本 + git commit)。
 *
 * 这块 UI 的存在理由:NSIS 包名钉死在版本号上,版本又长期不 bump,于是「装了还是
 * 旧 UI」在文件名层面完全无从判断。壳内报一次 `<version>-<commit>`,一眼可验。
 */
import { createSignal, type Component } from "solid-js";
import { Section } from "./controls";
import { loadBuildInfo, type BuildInfo } from "../lib/version";

export const AboutSection: Component = () => {
  const [build, setBuild] = createSignal<BuildInfo | null>(null);
  const [failed, setFailed] = createSignal(false);

  // 只读一次:构建标识不随配置变,没有刷新语义。
  loadBuildInfo().then(setBuild, () => { setFailed(true); });

  const version = (): string => {
    if (failed()) return "壳未提供 app_version";
    const info = build();
    if (info == null) return "读取中…";
    return info.unavailable ? "浏览器 dev 环境:无壳" : info.display;
  };

  const commit = (): string => {
    const info = build();
    return info == null || info.unavailable ? "—" : info.commit;
  };

  return (
    <Section
      id="section-about"
      title="关于"
      desc="桌面壳自身的构建标识;daemon 是独立 sidecar,版本随包一起出。"
    >
      <div class="readonly-grid">
        <span>版本</span>
        <b>{version()}</b>
        <span>commit</span>
        <b>{commit()}</b>
      </div>
    </Section>
  );
};
