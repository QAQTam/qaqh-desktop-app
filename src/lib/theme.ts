/**
 * 主题解析:config 的 theme 字段("" = 跟随系统 / light / dark)→
 * `documentElement[data-theme]`。CSS 侧以 `:root[data-theme="dark"]` 消费,
 * 首帧(pre-JS)由 `prefers-color-scheme` 媒体查询兜底;diff 的 shiki 高亮
 * 从 `resolvedTheme()` 读解析结果选配色。
 */
import { createSignal } from "solid-js";

export type ResolvedTheme = "light" | "dark";

const systemDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

const [resolved, setResolved] = createSignal<ResolvedTheme>(systemDark?.matches ? "dark" : "light");

/** config.theme 的现值;null = 尚未从 config.load 拿到(按跟随系统处理)。 */
let configTheme: string | null = null;
let themeTransitionTimer: number | undefined;

const prefersReducedMotion = typeof matchMedia === "function"
  ? matchMedia("(prefers-reduced-motion: reduce)")
  : null;

function recompute(animate = true): void {
  const root = document.documentElement;
  const next: ResolvedTheme =
    configTheme === "light" || configTheme === "dark"
      ? configTheme
      : systemDark?.matches
        ? "dark"
        : "light";
  const previous = root.dataset.theme;
  if (animate && previous != null && previous !== next && !prefersReducedMotion?.matches) {
    root.classList.add("theme-transition");
    if (themeTransitionTimer != null) window.clearTimeout(themeTransitionTimer);
    themeTransitionTimer = window.setTimeout(() => {
      root.classList.remove("theme-transition");
      themeTransitionTimer = undefined;
    }, 220);
  } else if (!animate || prefersReducedMotion?.matches) {
    root.classList.remove("theme-transition");
    if (themeTransitionTimer != null) window.clearTimeout(themeTransitionTimer);
    themeTransitionTimer = undefined;
  }
  setResolved(next);
  root.dataset.theme = next;
}

/** config 的 theme 值进来(空串 = 跟随系统);config.load 与每次改动都会调用。 */
export function applyConfigTheme(value: string | null | undefined, animate = true): void {
  configTheme = value ?? "";
  recompute(animate);
}

if (systemDark != null) {
  systemDark.addEventListener("change", () => recompute());
  recompute();
}

export const resolvedTheme = resolved;
