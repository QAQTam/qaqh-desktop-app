/** 同一文本块只挂载一个 Markdown。工作段在回复边界关闭,后续工作不重开旧段。 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, Switch, Match, untrack, type Accessor, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconChevronRight from "~icons/lucide/chevron-right";
import { Collapse } from "../ui/Collapse";
import { Markdown } from "../markdown/Markdown";
import { StepRow } from "../tools/StepRow";
import { STR, formatWorkDuration } from "../lib/strings";
import { workDurationMs } from "../lib/time";
import type { SessionStore } from "../session/store";
import type { Step, Turn, Wait } from "../session/types";
import { turnSegments, type TurnSegment, type WorkSegment } from "./segments";

const WorkStep: Component<{ step: Accessor<Step>; turn: Turn }> = (props) => {
  const thinking = createMemo(() => { const step = props.step(); return step.kind === "thinking" ? step : null; });
  const tool = createMemo(() => { const step = props.step(); return step.kind === "tool" ? step : null; });
  const [thinkingOverride, setThinkingOverride] = createSignal<boolean | null>(null);
  const thinkingOpen = () => thinkingOverride() ?? (thinking() != null && props.turn.status === "running" && thinking()?.endedAt == null);
  let thinkingRow: HTMLDivElement | undefined;
  let following = true;
  let frame: number | null = null;
  let resizeObserver: ResizeObserver | undefined;

  const followTail = (): void => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const scroller = thinkingRow?.querySelector<HTMLDivElement>(".thinking-full");
      if (following && scroller?.isConnected) scroller.scrollTop = scroller.scrollHeight;
    });
  };
  createEffect(
    () => [thinkingOpen(), thinking()?.text] as const,
    ([open]) => { if (open) followTail(); },
  );
  onCleanup(() => {
    if (frame != null) cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
  });
  return (
    <Switch>
      <Match when={thinking() != null}>
        <div class="timeline-row thinking" ref={(node) => {
          thinkingRow = node;
          resizeObserver = new ResizeObserver(followTail);
          resizeObserver.observe(node);
        }}>
          <button type="button" class="timeline-label" aria-expanded={thinkingOpen() ? "true" : "false"} onClick={() => {
            following = true;
            setThinkingOverride(!thinkingOpen());
          }}>{STR.thinking}</button>
          <Collapse open={thinkingOpen()} instant={thinkingOverride() == null}>
            <div class="thinking-full" tabindex={0} role="region" aria-label={STR.thinking}
              onScroll={(event) => {
                const el = event.currentTarget;
                // Layout/resize can also emit scroll events; only user input
                // suspends following, while reaching the bottom resumes it.
                if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) following = true;
              }}
              onWheel={(event) => { if (event.deltaY < 0) following = false; }}
              onPointerDown={() => { following = false; }}
              onTouchStart={() => { following = false; }}
              onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) following = false; }}
            >{thinking()?.text}</div>
          </Collapse>
        </div>
      </Match>
      <Match when={tool() != null}><StepRow step={tool()!} turn={props.turn} /></Match>
    </Switch>
  );
};

const WorkGroup: Component<{ group: WorkSegment; turn: Turn; waits: Wait[] }> = (props) => {
  const [override, setOverride] = createSignal<boolean | null>(null);
  // 回复边界自动收起一次;之后用户仍可展开这个已完成工作段。
  createEffect(() => props.group.closed, (closed) => { if (closed) setOverride(null); });
  const open = () => override() ?? !props.group.closed;
  const groups = createMemo(() => {
    const steps = props.group.steps;
    return untrack(() => Array.from({ length: Math.ceil(steps.length / 8) }, (_, index) => ({ key: steps[index * 8]!.id, steps: steps.slice(index * 8, index * 8 + 8) })));
  }, { name: "work.structure" });
  const waits = createMemo(() => {
    const start = props.group.steps[0]?.startedAt ?? props.turn.workStartedAt ?? 0;
    return props.waits.filter((wait) => wait.from >= start && wait.from < (props.group.until ?? Infinity));
  });
  const label = () => {
    const steps = props.group.steps;
    const start = steps[0]?.startedAt ?? props.turn.workStartedAt;
    const end = props.group.until ?? steps[steps.length - 1]?.endedAt;
    const duration = workDurationMs(start, end, waits());
    const text = duration == null ? "" : formatWorkDuration(duration);
    if (props.turn.status === "failed") return STR.failedWorked(text);
    if (props.turn.status === "aborted") return STR.interruptedWorked(text);
    return props.group.closed ? STR.worked(text) : "正在工作";
  };
  return (
    <div class="work-group" data-work-key={props.group.key}>
      <button type="button" class="collapsed-row" aria-expanded={open() ? "true" : "false"} onClick={() => setOverride(!open())}>
        <Show when={open()} fallback={<IconChevronRight />}><IconChevronDown /></Show><span>{label()}</span>
      </button>
      <Collapse open={open()} instant={override() == null}>
        <div class="timeline turn-steps">
          <For each={groups()} keyed={(group) => group.key}>{(group) => <div class="work-step-group"><For each={group().steps} keyed={(step) => step.id}>{(step) => <WorkStep step={step} turn={props.turn} />}</For></div>}</For>
          <For each={waits()}>{(wait) => <div class="timeline-row wait"><span class="timeline-label">{wait.kind === "approval" ? STR.waitApproval(formatWorkDuration(Math.max(0, (wait.to ?? wait.from) - wait.from))) : STR.waitAnswer(formatWorkDuration(Math.max(0, (wait.to ?? wait.from) - wait.from)))}</span></div>}</For>
        </div>
      </Collapse>
    </div>
  );
};

const SegmentView: Component<{ segment: Accessor<TurnSegment>; turn: Turn; waits: Wait[] }> = (props) => {
  const work = createMemo(() => { const segment = props.segment(); return segment.kind === "work" ? segment : null; });
  const text = createMemo(() => { const segment = props.segment(); return segment.kind === "text" ? segment.step : null; });
  return (
    <Switch>
      <Match when={work() != null}><WorkGroup group={work()!} turn={props.turn} waits={props.waits} /></Match>
      <Match when={text() != null}>
        <div data-text-id={text()!.id} class={{ "turn-answer": text()!.id === props.turn.answerStepId, "turn-intermediate": text()!.id !== props.turn.answerStepId }}>
          <Markdown text={() => text()!.text} revision={text()!.id} streaming={props.turn.status === "running" && text()!.endedAt == null} />
        </div>
      </Match>
    </Switch>
  );
};

export const TurnView: Component<{ turn: Turn; waits: Wait[]; store: SessionStore }> = (props) => {
  const segments = createMemo(() => {
    const steps = props.turn.steps;
    steps.length;
    const terminal = props.turn.status !== "running";
    return untrack(() => turnSegments(steps, terminal));
  }, { name: "turn.structure" });
  return (
    <section class="turn">
      <div class="turn-user"><div class="bubble">{props.turn.user.text}</div></div>
      <For each={segments()} keyed={(segment) => segment.key}>{(segment) => <SegmentView segment={segment} turn={props.turn} waits={props.waits} />}</For>
      <Show when={props.turn.status === "aborted" && props.turn.steps.length === 0}><div class="turn-aborted">{STR.interrupted}</div></Show>
      <Show when={props.turn.status === "failed" && props.turn.error != null}><div class="turn-error">{props.turn.error!.message}</div></Show>
    </section>
  );
};
