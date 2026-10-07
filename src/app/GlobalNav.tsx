import { For, type Component } from "solid-js";
import IconMessageSquare from "~icons/lucide/message-square";
import IconSettings from "~icons/lucide/settings";
import IconWrench from "~icons/lucide/wrench";

export type GlobalSection = "messages" | "tools" | "settings";

const ITEMS = [
  { id: "messages", label: "消息", Icon: IconMessageSquare },
  { id: "tools", label: "工具", Icon: IconWrench },
  { id: "settings", label: "设置", Icon: IconSettings },
] as const;

export const GlobalNav: Component<{
  active: GlobalSection;
  onNavigate: (section: GlobalSection) => void;
}> = (props) => (
  <nav class="global-nav" aria-label="主导航">
    <For each={ITEMS}>
      {(item) => (
        <button
          type="button"
          class={`global-nav-item${props.active === item.id ? " active" : ""}`}
          aria-current={props.active === item.id ? "page" : undefined}
          onClick={() => props.onNavigate(item.id)}
        >
          <item.Icon />
          <span>{item.label}</span>
        </button>
      )}
    </For>
  </nav>
);
