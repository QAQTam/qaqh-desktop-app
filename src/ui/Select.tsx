/**
 * Fluent 下拉选择器。
 *
 * 原生 <select> 在 WebView2 里永远是浏览器弹层（白底、系统高亮、无法做
 * WinUI 的 32px 行高 / Acrylic / 选中勾），这是设置页最明显的"网页感"来源。
 * 这里用 Kobalte 的 Select 作为行为层（键盘、typeahead、焦点、外部点击、
 * 滚动锁定），外观完全由本仓的 Fluent token 驱动。
 */
import { type Component } from "solid-js";
import { Select as KSelect } from "@kobalte/core/select";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

const OptionRow: Component<{ item: { rawValue: SelectOption } }> = (props) => (
  <KSelect.Item item={props.item as never} class="select-item">
    <span class="select-item-label">{props.item.rawValue.label}</span>
    <KSelect.ItemIndicator class="select-item-indicator">
      <IconCheck />
    </KSelect.ItemIndicator>
  </KSelect.Item>
);

export const Select: Component<{
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  class?: string;
  /** 选中后仍显示占位（用于"套用模板"这种一次性动作）。 */
  keepPlaceholder?: boolean;
}> = (props) => {
  // 旧 profile / 手改 config 里可能留着不在选项表里的值：补一条同名项，
  // 避免触发器显示空白（Kobalte 找不到匹配项时不会自动回显）。
  const options = (): SelectOption[] => {
    const list = [...props.options];
    if (props.value !== "" && !list.some((item) => item.value === props.value)) {
      list.unshift({ value: props.value, label: props.value });
    }
    return list;
  };

  const selected = (): SelectOption | null =>
    props.keepPlaceholder ? null : (options().find((item) => item.value === props.value) ?? null);

  return (
    <KSelect
      options={options()}
      optionValue="value"
      optionTextValue="label"
      optionDisabled="disabled"
      value={selected()}
      onChange={(next) => {
        if (next != null) props.onChange(next.value);
      }}
      placeholder={props.placeholder ?? ""}
      disabled={props.disabled}
      disallowEmptySelection={!props.keepPlaceholder}
      sameWidth
      gutter={4}
      itemComponent={OptionRow}
    >
      <KSelect.Trigger
        id={props.id}
        class={`field-input select-trigger${props.class ? ` ${props.class}` : ""}`}
        aria-label={props.ariaLabel}
      >
        <KSelect.Value>
          {(state) => {
            const option = state.selectedOption() as SelectOption | undefined;
            return (
              <span class="select-trigger-label" data-placeholder={option == null ? "true" : undefined}>
                {option?.label ?? props.placeholder ?? ""}
              </span>
            );
          }}
        </KSelect.Value>
        <KSelect.Icon class="select-trigger-icon">
          <IconChevronDown />
        </KSelect.Icon>
      </KSelect.Trigger>
      <KSelect.Portal>
        <KSelect.Content class="select-content">
          <KSelect.Listbox class="select-listbox" />
        </KSelect.Content>
      </KSelect.Portal>
    </KSelect>
  );
};
