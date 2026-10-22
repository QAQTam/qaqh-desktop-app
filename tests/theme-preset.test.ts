// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyThemePreset,
  storedThemePreset,
  THEME_PRESET_OPTIONS,
  type ThemePreset,
} from "../src/lib/theme";

describe("主题预设解耦与无残留切换测试", () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, val); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };

  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
    // 重置 documentElement
    const root = document.documentElement;
    delete root.dataset.themePreset;
    for (const cls of Array.from(root.classList)) {
      if (cls.startsWith("theme-")) root.classList.remove(cls);
    }
  });

  it("THEME_PRESET_OPTIONS 清单中应完整包含 default、liquid-glass 与 zen-console", () => {
    const ids = THEME_PRESET_OPTIONS.map((opt) => opt.value);
    expect(ids).toContain("default");
    expect(ids).toContain("liquid-glass");
    expect(ids).toContain("zen-console");
  });

  it("应用 zen-console 预设时，正确注入 dataset 与类名，且无其他预设残留", () => {
    applyThemePreset("zen-console");

    const root = document.documentElement;
    expect(root.dataset.themePreset).toBe("zen-console");
    expect(root.classList.contains("theme-zen-console")).toBe(true);
    expect(root.classList.contains("theme-liquid-glass")).toBe(false);
    expect(storedThemePreset()).toBe("zen-console");
  });

  it("在不同预设之间连续切换时，历史主题类名必须完全清除，杜绝样式泄漏与残留", () => {
    const root = document.documentElement;

    // 1. 切到 zen-console
    applyThemePreset("zen-console");
    expect(root.dataset.themePreset).toBe("zen-console");
    expect(root.classList.contains("theme-zen-console")).toBe(true);

    // 2. 切到 liquid-glass
    applyThemePreset("liquid-glass");
    expect(root.dataset.themePreset).toBe("liquid-glass");
    expect(root.classList.contains("theme-liquid-glass")).toBe(true);
    // 必须确认旧主题类名已彻底被清除！
    expect(root.classList.contains("theme-zen-console")).toBe(false);

    // 3. 切回 default
    applyThemePreset("default");
    expect(root.dataset.themePreset).toBeUndefined();
    expect(root.classList.contains("theme-liquid-glass")).toBe(false);
    expect(root.classList.contains("theme-zen-console")).toBe(false);
    expect(storedThemePreset()).toBe("default");
  });
});
