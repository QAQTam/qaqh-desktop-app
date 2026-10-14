# Markdown 排版基准

核对日期：2026-10-08，正文基准于 2026-10-14 修订（见「正文基准的偏离」）。适用于所有 `.md-host`，包括中途回复与最终回答。

## 官方依据与选型

以 **GitHub Primer 官方 Markdown 样式**为元素比例基准，不混搭不同公司的字号（**正文绝对字号自 2026-10-14 起偏离 Primer，见下一节**）：

- [Primer 官方 Markdown 使用说明](https://primer.style/product/getting-started/react/#markdown-content)：内容样式独立于界面控件样式。
- [markdown-body.scss](https://github.com/primer/css/blob/main/src/markdown/markdown-body.scss)：正文采用 `$h4-size` 与 `$body-line-height`。
- [typography.scss](https://github.com/primer/css/blob/main/src/support/variables/typography.scss)：上述值分别为 16px、1.5，正常字重 400、标题字重默认 600。
- [headings.scss](https://github.com/primer/css/blob/main/src/markdown/headings.scss)：六级标题比例、1.25 行高和上下间距。
- [code.scss](https://github.com/primer/css/blob/main/src/markdown/code.scss)：行内代码与代码块采用 85%；`pre code` 必须回到 100%，不能二次缩小。

对照而不混用：[Microsoft Fluent 2 Typography](https://fluent2.microsoft.design/typography) 提供 Web/Windows UI 角色尺度；[IBM Carbon Typography](https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets) 区分产品界面与阅读场景。它们不是本项目 Markdown 元素尺寸的来源。

来源是核对日官方 main 分支，不声称永久固定版本。未来调整必须记录来源变更，并更新浏览器计算样式验收。

## 正文基准的偏离（2026-10-14）

正文从 Primer 的 `16px / 1.5` 改为 **`14px / 24px 行距`**（`--md-body-leading: calc(24 / 14)`）。标题与代码的**比例**不变，仍按 Primer 从正文推导。

依据是对三家桌面端同尺寸截图（1919×1079、Windows 缩放 100%，故截图像素 = CSS 像素）做全角汉字步进实测。CJK 全角 advance 在任一候选字面下都精确等于 1em（已验证：HarmonyOS Sans SC、Microsoft YaHei UI、system-ui、sans-serif 在 100px em 下「理国测试」均为 400px），所以实测步进就是字号：

| | 全角步进＝字号 | 基线行距 | 行高比 |
| --- | --- | --- | --- |
| QAQH（改前） | 16px | 24px | 1.50 |
| Codex 桌面端 | **14px** | 23–24px | ~1.65 |
| Qoder 桌面端 | 13px | 24px | ~1.85 |

三家的行距本来就一致是 24px，差的只有字号。选型取 Codex 的 14px。

**为什么行距要写成 `calc(24 / 14)` 而不是比例值**：`1.5` 把行距和字号焊死了，14px 会连带把行距拖到 21px——字和行一起缩，视觉密度没变，这正是「设成 14px 还是觉得大、设成 12px 又太小」的原因。把行距钉在 24px 才能只动字号，同时保住代码块、交付卡、分隔线和贴底滚动的既有垂直节奏。

字面不是变量：同一 em 下 HarmonyOS Sans SC 的墨盒（185×164）比系统 YaHei（195×175）**还小** 5–7%，换字面只会让文字更大。

### 阅读区现在吃「全局字号缩放」

`--md-body-size` 写成 `calc(14px * var(--font-scale))`。设置页那条 hint 本来就承诺"等比缩放界面中所有字阶"，此前只有外壳兑现、`.md-host` 纹丝不动，属于对自家说明的缺陷。

接线只需要这一个 token：`--md-body-leading` 是**无单位比例**，正文一乘系数行距自己跟上；标题走 em、代码走 85%，同理。14/24 在 90%～120% 四档下依次是 12.6/21.6、14/24、15.4/26.4、16.8/28.8。`scripts/layout-check.mjs` 用 1.2 档实测 16.8px/28.8px，并钉住探针测完必须还原。

## 字号矩阵

下表的 px 是官方比例在 **14px** 正文基准下的展开值（由 `scripts/layout-check.mjs` 在真实浏览器里按计算样式核对），不是另行设计的尺度。

| 元素 | 官方规则 | 计算字号 / 行高 | 字重 |
| --- | --- | --- | --- |
| 正文、列表、引用、表格 | `calc(14px * var(--font-scale))` / `calc(24 / 14)`，子元素继承 | 14 / 24px（100% 档） | 400 |
| H1 | 2em / 1.25 | 28 / 35px | 600 |
| H2 | 1.5em / 1.25 | 21 / 26.25px | 600 |
| H3 | 1.25em / 1.25 | 17.5 / 21.875px | 600 |
| H4 | 1em / 1.25 | 14 / 17.5px | 600 |
| H5 | .875em / 1.25 | 12.25 / 15.3125px | 600 |
| H6 | .85em / 1.25 | 11.9 / 14.875px | 600，次级颜色 |
| 普通正文行内代码 | 85% | 11.9 / 20.4px（继承无单位行距，段落行框仍为 24px） | 400 |
| 标题内代码 | inherit | 与所在标题相同 | 继承标题 |
| 围栏代码块 pre | 85% / 1.45 | 11.9 / 17.255px | 400 |
| pre 内 code | 100% / inherit | 11.9 / 17.255px，不再缩小 | 400 |
| strong / 表头 | 不另改字号 | 与所在内容相同 | 600 |

标题上距 24px、下距 16px；段落下距 16px。H1/H2 保留 Primer 的底部细分隔线。窄窗口不擅自替换成 UI 通用标题尺度，缩放由浏览器/宿主负责。

## 本项目适配项

- 不引入 React/Primer 运行时依赖；只把官方排版规则映射到 `src/styles/app.css` 的 `--md-*` token 和现有净化后的 DOM。
- 使用已有中文无衬线字体、Cascadia Code、主题颜色、圆角、代码复制栏及表格局部滚动机制。这些是宿主适配，不宣称是 Primer 原样外观。
- UI 标签、工具元信息、思考日志不通过修改 `.md-host` 基准来调大小。
- `scripts/layout-check.mjs` 检查真实 Markdown DOM 的矩阵、中途/最终一致性及列表标记；`scripts/visual-capture.mjs` 检查完整壳布局。
