/** 面向用户的工具结果：文件路径/diff、exec 流、待办/skills 语义。 */
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, type Component } from "solid-js";
import IconFile from "~icons/lucide/file-text";
import IconEdit from "~icons/lucide/file-pen-line";
import IconSearch from "~icons/lucide/search";
import IconTerminal from "~icons/lucide/square-terminal";
import IconWrench from "~icons/lucide/wrench";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconCopy from "~icons/lucide/copy";
import IconLoader from "~icons/lucide/loader-circle";
import IconX from "~icons/lucide/x";
import { Collapse } from "../ui/Collapse";
import { hasAnsi, parseAnsi } from "../lib/ansi";
import { STR, formatWorkDuration } from "../lib/strings";
import { now } from "../lib/time";
import { DiffList } from "../diff/DiffView";
import type { ToolStep, Turn } from "../session/types";
import { primaryArg, toolLabel } from "./registry";
import { isSkillStep, semanticLabel, shellContent, toolPaths, toolPresentation } from "./presentation";
import { toolCommandIcon } from "./command-icons";

const CopyButton: Component<{ text: () => string }> = (props) => {
  const [copied, setCopied] = createSignal(false);
  return <button type="button" class="ghost-mini" title={STR.copy} onClick={(event) => {
    event.stopPropagation();
    void navigator.clipboard.writeText(props.text()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  }}>{copied() ? STR.copied : STR.copy}<IconCopy /></button>;
};

const LiveElapsed: Component<{ startedAt: number | undefined }> = (props) => {
  const [tick, setTick] = createSignal(now());
  const timer = setInterval(() => setTick(now()), 1_000);
  onCleanup(() => clearInterval(timer));
  return <span class="tool-elapsed">{formatWorkDuration(props.startedAt == null ? 0 : Math.max(0, tick() - props.startedAt))}</span>;
};

const AnsiBlock: Component<{ text: string }> = (props) => (
  <Show when={hasAnsi(props.text)} fallback={<pre class="tool-text">{props.text}</pre>}>
    <pre class="tool-text"><For each={parseAnsi(props.text)} keyed={false}>{(chunk) => <span style={{ color: chunk().color, background: chunk().background, "font-weight": chunk().bold ? "600" : "", "font-style": chunk().italic ? "italic" : "", "text-decoration": chunk().underline ? "underline" : "" }}>{chunk().text}</span>}</For></pre>
  </Show>
);

const ExecResult: Component<{ step: ToolStep }> = (props) => {
  const content = createMemo(() => shellContent(props.step));
  const live = () => props.step.status === "running" || props.step.status === "pending";
  let scroller: HTMLDivElement | undefined;
  let following = true;
  let frame: number | undefined;
  createEffect(() => content(), () => {
    if (frame != null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = undefined; if (following && scroller) scroller.scrollTop = scroller.scrollHeight; });
  });
  onCleanup(() => { if (frame != null) cancelAnimationFrame(frame); });
  return <>
    <Show when={content().text || content().stderr}>
      <div class="tool-detail-label">{live() ? "运行输出" : "执行结果"}<span class="spacer" /><CopyButton text={() => [content().text, content().stderr].filter(Boolean).join("\n")} /></div>
      <div ref={scroller} class={{ "tool-shell-output": true, "tool-progress": live() }} tabindex={0} role="region" aria-label={live() ? "运行输出" : "执行结果"}
        onWheel={(event) => { if (event.deltaY < 0) following = false; }}
        onPointerDown={() => { following = false; }} onTouchStart={() => { following = false; }}
        onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) following = false; }}
        onScroll={(event) => { const el = event.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) following = true; }}>
        <Show when={content().text}><AnsiBlock text={content().text} /></Show>
        <Show when={content().stderr}><div class="tool-detail-label">stderr</div><pre class="tool-text tool-stderr">{content().stderr}</pre></Show>
      </div>
    </Show>
    <Show when={content().truncated}><div class="tool-truncated">仅显示输出尾部</div></Show>
  </>;
};

export const ToolDetail: Component<{ step: ToolStep }> = (props) => {
  const step = () => props.step;
  const file = () => !isSkillStep(step()) && ["read", "edit"].includes(toolPresentation(step()));
  return <div class="tool-detail">
    <Show when={file()}>
      <Show when={step().status === "success" && step().output?.diffText}>
        <div class="tool-detail-label">修改结果<span class="spacer" /><CopyButton text={() => step().output?.diffText ?? ""} /></div>
        <DiffList diffText={step().output!.diffText!} hideSingleFilePath />
      </Show>
    </Show>
    <Show when={toolPresentation(step()) === "shell"}>
      <ExecResult step={step()} />
    </Show>
    <Show when={step().error}><pre class="tool-text tool-error">{step().error}</pre></Show>
    <Show when={step().permission != null && (step().status === "pending" || step().status === "running")}>
      <div class="tool-waiting">等待授权:{step().permission?.reason || step().permission?.category}</div>
    </Show>
  </div>;
};

export const StepRow: Component<{ step: ToolStep; turn: Turn; expandable?: boolean; cwd?: string | null }> = (props) => {
  const step = () => props.step;
  const kind = () => isSkillStep(step()) ? "skill" : toolPresentation(step());
  const semantic = () => semanticLabel(step());
  const commandIcon = () => kind() === "shell" ? toolCommandIcon(step().argsJson, step().display) : undefined;
  const paths = createMemo(() => ["read", "edit"].includes(kind()) ? toolPaths(step(), props.cwd) : []);
  const summary = () => semantic() ? "" : paths().length ? paths().join(" · ") : primaryArg(step().argsJson, step().display);
  const hasDetails = () => kind() === "shell"
    || (["read", "edit"].includes(kind()) && step().status === "success" && Boolean(step().output?.diffText))
    || Boolean(step().error || (step().permission && ["pending", "running"].includes(step().status)));
  const [override, setOverride] = createSignal<boolean | null>(null);
  // exec 默认直接展示流与终态输出；用户折叠意图优先且不会被终态重置。
  const open = () => hasDetails() && (override() ?? (kind() === "shell" || step().status === "error"));
  const stats = createMemo(() => {
    if (kind() !== "edit" || step().status !== "success") return null;
    const add = step().display?.lines_added ?? 0, del = step().display?.lines_removed ?? 0;
    return add || del ? { add, del } : null;
  });
  return <div class={{ "step-row": true, tool: true, [`st-${step().status}`]: true }}>
    <button type="button" class="tool-head" disabled={!hasDetails()} aria-expanded={hasDetails() ? open() ? "true" : "false" : undefined} onClick={() => setOverride(!open())}>
      <Switch>
        <Match when={step().status === "pending" || step().status === "running"}><span class="tool-icon spin"><IconLoader /></span></Match>
        <Match when={step().status === "success"}><span class="tool-icon muted" title="已完成"><Switch fallback={<IconWrench />}>
          <Match when={kind() === "shell"}><IconTerminal /></Match><Match when={kind() === "read" || kind() === "skill"}><IconFile /></Match><Match when={kind() === "edit"}><IconEdit /></Match><Match when={kind() === "search"}><IconSearch /></Match>
        </Switch></span></Match>
        <Match when={step().status === "error" || step().status === "denied"}><span class="tool-icon err"><IconX /></span></Match>
        <Match when={step().status === "aborted" || step().status === "backgrounded"}><span class="tool-icon muted"><IconChevronRight /></span></Match>
      </Switch>
      <span class="tool-name">{semantic() ?? toolLabel(step().name)}</span>
      <span class="tool-summary" title={summary()}>
        <Show when={commandIcon()}>{(icon) => <img class="tool-command-icon" src={icon().src} alt="" aria-hidden="true" title={icon().label} draggable={false} />}</Show>
        <span class="tool-summary-text">{summary()}</span>
      </span>
      <Show when={stats()}><span class="tool-diffstat"><b class="diff-stat-add">+{stats()!.add}</b><b class="diff-stat-del">−{stats()!.del}</b></span></Show>
      <Switch>
        <Match when={step().status === "running"}><LiveElapsed startedAt={step().startedAt} /></Match>
        <Match when={step().status === "error"}><span class="tool-state err">{STR.failed}</span></Match>
        <Match when={step().status === "denied"}><span class="tool-state err">已拒绝</span></Match>
        <Match when={step().status === "aborted"}><span class="tool-state">{STR.aborted}</span></Match>
        <Match when={step().status === "backgrounded"}><span class="tool-state">{STR.backgrounded}</span></Match>
      </Switch>
      <Show when={hasDetails()}><IconChevronRight class={`tool-chevron${open() ? " is-open" : ""}`} /></Show>
    </button>
    <Collapse open={open()}><ToolDetail step={step()} /></Collapse>
  </div>;
};
