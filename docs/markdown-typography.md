# Markdown 排版基准

核对日期：2026-10-08。适用于所有 `.md-host`，包括中途回复与最终回答。

## 官方依据与选型

以 **GitHub Primer 官方 Markdown 样式**为唯一内容排版基准，不混搭不同公司的字号：

- [Primer 官方 Markdown 使用说明](https://primer.style/product/getting-started/react/#markdown-content)：内容样式独立于界面控件样式。
- [markdown-body.scss](https://github.com/primer/css/blob/main/src/markdown/markdown-body.scss)：正文采用 `$h4-size` 与 `$body-line-height`。
- [typography.scss](https://github.com/primer/css/blob/main/src/support/variables/typography.scss)：上述值分别为 16px、1.5，正常字重 400、标题字重默认 600。
- [headings.scss](https://github.com/primer/css/blob/main/src/markdown/headings.scss)：六级标题比例、1.25 行高和上下间距。
- [code.scss](https://github.com/primer/css/blob/main/src/markdown/code.scss)：行内代码与代码块采用 85%；`pre code` 必须回到 100%，不能二次缩小。

对照而不混用：[Microsoft Fluent 2 Typography](https://fluent2.microsoft.design/typography) 提供 Web/Windows UI 角色尺度；[IBM Carbon Typography](https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets) 区分产品界面与阅读场景。它们不是本项目 Markdown 元素尺寸的来源。

来源是核对日官方 main 分支，不声称永久固定版本。未来调整必须记录来源变更，并更新浏览器计算样式验收。

## 字号矩阵

下表的 px 是官方比例在 16px 正文基准下的展开值，不是另行设计的尺度。

| 元素 | 官方规则 | 计算字号 / 行高 | 字重 |
| --- | --- | --- | --- |
| 正文、列表、引用、表格 | 16px / 1.5，子元素继承 | 16 / 24px | 400 |
| H1 | 2em / 1.25 | 32 / 40px | 600 |
| H2 | 1.5em / 1.25 | 24 / 30px | 600 |
| H3 | 1.25em / 1.25 | 20 / 25px | 600 |
| H4 | 1em / 1.25 | 16 / 20px | 600 |
| H5 | .875em / 1.25 | 14 / 17.5px | 600 |
| H6 | .85em / 1.25 | 13.6 / 17px | 600，次级颜色 |
| 普通正文行内代码 | 85% | 13.6 / 20.4px（继承 1.5，段落行框仍为 24px） | 400 |
| 标题内代码 | inherit | 与所在标题相同 | 继承标题 |
| 围栏代码块 pre | 85% / 1.45 | 13.6 / 19.72px | 400 |
| pre 内 code | 100% / inherit | 13.6 / 19.72px，不再缩小 | 400 |
| strong / 表头 | 不另改字号 | 与所在内容相同 | 600 |

标题上距 24px、下距 16px；段落下距 16px。H1/H2 保留 Primer 的底部细分隔线。窄窗口不擅自替换成 UI 通用标题尺度，缩放由浏览器/宿主负责。

## 本项目适配项

- 不引入 React/Primer 运行时依赖；只把官方排版规则映射到 `src/styles/app.css` 的 `--md-*` token 和现有净化后的 DOM。
- 使用已有中文无衬线字体、Cascadia Code、主题颜色、圆角、代码复制栏及表格局部滚动机制。这些是宿主适配，不宣称是 Primer 原样外观。
- UI 标签、工具元信息、思考日志不通过修改 `.md-host` 基准来调大小。
- `scripts/layout-check.mjs` 检查真实 Markdown DOM 的矩阵、中途/最终一致性及列表标记；`scripts/visual-capture.mjs` 检查完整壳布局。
