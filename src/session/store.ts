/**
 * 一个标签页 = 一个会话的客户端状态机。
 *
 * 宿主契约(webui-tauri):所有 per-seed 面(命令/审批/RPC/timeline 流/快照)
 * 经 Rust 宿主的类型化 IPC 转发,宿主维护「单一 active seed 持流」(plan D4);
 * 切标签 = attach(宿主切 active + 重建流)+ 快照重建(权威对齐)。后台标签
 * 不收流,状态由标签页轮询 sessions 列表(turn_count/running,后端事实)驱动
 * 状态点。重连/退避/续传责任在宿主(qaqh-client),前端不再有 SSE 循环。
 *
 * 数据单源:transcript 结构/文本只来自 timeline(宿主转发的快照+SSE 帧,
 * `watermark` 去重 + 缺口触发快照);审批只来自 approvals RPC(投影事件仅当
 * 刷新信号);自动标题由 v2 Meta SSE 推送,会话目录与运行态由 sessions 列表对齐。
 */
import { createSignal, createStore } from "solid-js";
import { transport, tauriHost, type ApprovalView, type StreamHandlers, type TimelineStatusWire, type TodoItemWire } from "../lib/transport";
import { now } from "../lib/time";
import { applyEntry, applySnapshot, emptySession, prependPage } from "./reducer";
import { evictForWindow, fillGapHeights } from "./pagination";
import type { SessionState, TimelineEntryWire, Wait } from "./types";
import { normalizeActivity, projectionActions, readProjection, type SessionActivity } from "./projection";
import { reduceCompact, type CompactState } from "./compact";
import type { ConfigDto } from "../api/qaqh/ConfigDto";
import type { ContentRef } from "../api/qaqh/ContentRef";
import type { UsageInfo } from "../api/qaqh/UsageInfo";

export type ConnectionKind = "connected" | "reconnecting" | "offline";

/**
 * 压缩的展示态机在 `./compact`(纯函数,带线上样本单测);这里只负责把它接到
 * 投影事件上。命令 ack 只做乐观 running,`compaction_applied` 事实与
 * `compact_finished` 事件都能独立收口——两种来源都能收敛。
 */
export type { CompactState } from "./compact";

/**
 * 待发附件。`id` 是宿主回传的绝对路径——只作本地键,**从不进任何命令**;
 * 发送时带出去的是上传换回来的 `reference`。
 */
export interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  state: "uploading" | "ready" | "failed";
  reference: ContentRef | null;
  error: string | null;
}

/** 路径末段;上传前的占位名(上传完成后用宿主回的真名)。 */
function attachmentName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export interface ComposerMetrics {
  /** Last-turn completion throughput; tokens come from provider usage when available. */
  tokensPerSecond: number | null;
  contextPercent: number | null;
  cacheHitPercent: number | null;
  /** 上一轮端点回的原生 usage 整数项(`credit` 等未建模字段);没有就是空对象。 */
  extras: Record<string, number>;
}

function cacheHitPercent(usage: UsageInfo): number | null {
  if (usage.cache_usage_reported !== true) return null;
  const total = usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens;
  return total > 0 ? (usage.prompt_cache_hit_tokens / total) * 100 : null;
}

/** 一帧之内攒下来的同一种增量(按「种类 + 回合 + 块」归并)。 */
interface PendingFragment {
  turnId: string;
  blockId: string;
  /** `text_delta` 的累积文本,或 `tool_progress` 的累积输出。 */
  fragments: Array<{ seq: number; text: string }>;
  truncated: boolean;
  /** 已消费到的 seq(取批次里最大的那个)。 */
  seq: number;
  progress: boolean;
}

/** timeline 快照窗口页大小;向上翻页页大小(spec §14.2 limit=30)。 */
const SNAPSHOT_LIMIT = 50;
const PAGE_LIMIT = 30;
/** 缺口触发快照校正的最小间隔(防抖,高吞吐下不连环拉全量)。 */
const RESNAPSHOT_DEBOUNCE_MS = 2_000;

export class SessionStore {
  readonly seed: string;
  readonly state: [SessionState, (fn: (draft: SessionState) => void) => void];

  connection = createSignal<ConnectionKind>("reconnecting");
  activity = createSignal<SessionActivity | null>(null);
  composerMetrics = createSignal<ComposerMetrics>({ tokensPerSecond: null, contextPercent: null, cacheHitPercent: null, extras: {} });
  title = createSignal<string | null>(null);
  pending = createSignal<ApprovalView[]>([]);
  todos = createSignal<TodoItemWire[]>([]);
  loadError = createSignal(false);
  hasNewReply = createSignal(false);
  /** 「此前已压缩」分隔锚点回合 key;null = 渲染在顶部。 */
  compactedAfter = createSignal<string | null>(null);
  /** 压缩进行态与流式摘要(见 `CompactState`);idle 时 HUD 只显示百分比。 */
  compact = createSignal<CompactState>({ phase: "idle" });
  /** 待发附件;上传成功前不允许发送(命令里只能出现 `ContentRef`)。 */
  pendingAttachments = createSignal<PendingAttachment[]>([]);
  loadingOlder = createSignal(false);

  /**
   * 标签层注入的回调:本会话的元数据变了(标题/归档),去重拉 sessions 列表。
   * meta 频道只有已 attach 的会话才有流,后台会话的变更仍要等列表重拉。
   */
  onSessionsChanged: (() => void) | null = null;
  /** 标签层注入的回调：v2 MetaDelta::TitleChanged 到达时就地更新侧栏标题。 */
  onSessionTitleChanged: ((title: string) => void) | null = null;
  /** 标签层注入的回调:`MetaDelta::Deleted` 是权威终态,目录项与标签一起收掉。 */
  onSessionDeleted: (() => void) | null = null;

  /** 宿主事件反订阅。 */
  private hostUnlisten: (() => void) | null = null;
  /**
   * 帧内合并的高频增量(`text_delta` 与 `tool_progress`)。逐条写store 的代价有两层:
   * 每帧 N 次通知,以及 `tool_progress` 每次都要重做一遍 16KB 尾窗切片
   * (O(条数 × 16KB) 的字符串复制)。实测 400 个 chunk:合并前 2014ms。
   */
  private pendingFragments = new Map<string, PendingFragment>();
  /**
   * 已消费(立即应用,或进了 delta 缓冲)到的最大 seq。store 的 `watermark` 要等
   * 缓冲提交才推进,所以缺口判定必须看这个更高的值 —— 否则同一批里的第二条
   * delta 就会被当成缺口丢掉(夹具实测:连续喂 78 条只落地 10 条,文本每 2s 跳一次)。
   */
  private consumedSeq = 0;
  private rafHandle: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResnapshotAt = 0;
  private waitFrom: { kind: Wait["kind"]; at: number } | null = null;
  private lastTurnCount: number | null = null;
  private disposed = false;
  private todoRefresh: Promise<void> | null = null;
  private todoRefreshPending = false;
  private activeTurnStartedAt: number | null = null;
  private activeAnswerBlockIds = new Set<string>();
  private activeOutputStartedAt: number | null = null;
  private activeOutputEndedAt: number | null = null;
  private contextRefreshId = 0;
  /** 分母:最近一次 `config.load` 读到的窗口。 */
  private contextLength: number | null = null;
  /** 分子:上一轮服务端 usage 的 `prompt_tokens`,即真正发出去的上下文。 */
  private measuredContextTokens: number | null = null;

  constructor(seed: string) {
    this.seed = seed;
    // `name`:归因(attribution/diagnostics)里这条 store 的节点标成 `session.<key>`,
    // 否则热路径上的 memo 只能靠调用栈认。
    this.state = createStore<SessionState>(emptySession(), { name: "session" });
  }

  private get stateGet(): SessionState {
    return this.state[0];
  }

  private mutate(fn: (draft: SessionState) => void): void {
    this.state[1](fn);
  }

  private host(): NonNullable<ReturnType<typeof tauriHost>> {
    const host = tauriHost(transport);
    if (host == null) throw new Error("宿主传输后端不可用(应在 Tauri 壳内运行)");
    return host;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /** 成为活动标签:先订阅宿主事件(attach 发出的 timeline://status 事件不丢),
   *  再 attach——宿主取的权威首页会作为 `timeline://snapshot` 推回来,所以这里
   *  不再自己补一次 `resnapshot()`(那等于一次 attach 传两页、整表重建两遍)。 */
  async activate(): Promise<void> {
    if (this.disposed) return;
    this.hasNewReply[1](false);
    await this.connectHost();
    await transport.attach(this.seed, SNAPSHOT_LIMIT);
    void this.refreshApprovals();
    void this.refreshTodos();
    void this.refreshActivity();
    void this.refreshContextLength();
  }

  /** 失去活动资格(别的标签接管):退订宿主事件保状态(流由宿主在新 attach 时停)。 */
  deactivate(): void {
    this.closeHost();
    this.setConnection("reconnecting");
  }

  dispose(): void {
    this.disposed = true;
    this.closeHost();
    // 退订后还挂在队列里的 rAF 回调会带着已废弃标签的缓冲写进 store(一次性悬挂,
    // 不是泄漏级问题,但关掉它就不用解释它)。
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.pendingFragments.clear();
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  retry(): void {
    // 重连/退避在宿主侧,这里只触发宿主重建流(用户点「重试」/窗口聚焦)。
    this.setConnection("reconnecting");
    this.host()
      .streamsRetry(this.seed)
      .catch(() => this.setConnection("offline"));
  }

  private setConnection(kind: ConnectionKind): void {
    this.connection[1](kind);
  }

  private closeHost(): void {
    this.hostUnlisten?.();
    this.hostUnlisten = null;
  }

  // ── 宿主事件订阅(timeline://*, projection://*) ─────────────────────────────

  private async connectHost(): Promise<void> {
    if (this.disposed) return;
    this.closeHost();
    this.setConnection("reconnecting");
    const handlers: StreamHandlers = {
      onTimelineEntry: (seed, entry) => {
        if (seed === this.seed) this.onTimelineEntry(entry as TimelineEntryWire);
      },
      onTimelineStatus: (status) => {
        this.applyTimelineStatus(status);
      },
      onProjectionEvent: (seed, envelope) => {
        if (seed !== this.seed) return;
        this.applyProjection(envelope.stream_key as Record<string, any> | undefined, envelope.payload as Record<string, any> | undefined);
      },
      onProjectionReset: (seed) => {
        if (seed !== this.seed) return;
        // 宿主的 v2 流会自动以 snapshot cursor 重订阅;这里刷新派生信号即可。
        this.onSessionsChanged?.();
        void this.refreshApprovals();
        void this.refreshTodos();
        void this.refreshActivity();
      },
      onTimelineSnapshot: (page) => {
        // attach 的权威首页与宿主侧缺口恢复都走这里(前端不再自己补拉首页)。
        if (page.session_id != null && page.session_id !== this.seed) return;
        this.mutate((draft) => {
          applySnapshot(draft, page);
        });
        this.rebaseConsumed(page.snapshot?.watermark ?? 0);
        this.loadError[1](false);
      },
      onIncompatible: () => {},
      onHostError: () => {},
    };
    try {
      this.hostUnlisten = await this.host().subscribe(handlers);
    } catch {
      this.setConnection("offline");
      return;
    }
    // 兜底事件竞态:宿主可能在订阅完成前已发出 open(Tauri 事件不保留给晚到
    // 订阅者),订阅成功后主动查询一次宿主侧当前状态对齐。
    try {
      const status = await this.host().timelineStatus(this.seed);
      if (status != null) this.applyTimelineStatus(status);
    } catch {
      // best-effort:后续 status 事件仍会持续驱动。
    }
  }

  /** timeline 流状态 → connection 信号(其他 seed 的状态忽略)。 */
  private applyTimelineStatus(status: TimelineStatusWire): void {
    if (status.session_id != null && status.session_id !== this.seed) return;
    if (status.status === "open") {
      const reconnected = this.connection[0]() !== "connected";
      this.setConnection("connected");
      if (reconnected) void this.refreshTodos();
    } else if (status.status === "closed") {
      this.setConnection("offline");
    } else {
      this.setConnection("reconnecting");
    }
  }

  private onTimelineEntry(entry: TimelineEntryWire): void {
    if (typeof entry?.timeline_seq !== "number" || !entry.turn_id) return;
    // 「已经知道到哪」要同时看已提交的水位和已消费的 seq:delta 进缓冲时不写水位。
    const known = Math.max(this.stateGet.watermark, this.consumedSeq);
    if (entry.timeline_seq <= known) return; // 重复(重放)直接丢弃(幂等)
    if (entry.timeline_seq > known + 1 && known > 0) {
      // seq 缺口:丢弃该事件并触发一次快照校正(spec §15.2)。校正按 2s 防抖,
      // 且回合槽按 key 挂载 → 重建只更新数据,不再拆掉整屏 DOM。
      this.scheduleResnapshot();
      return;
    }
    const event = entry.event;
    if (event.type === "block_opened" && event.block.kind === "text") {
      this.activeAnswerBlockIds.add(event.block.block_id);
    } else if (event.type === "text_delta" && this.activeAnswerBlockIds.has(event.block_id)) {
      const at = now();
      this.activeOutputStartedAt ??= at;
      this.activeOutputEndedAt = at;
    } else if (event.type === "turn_sealed") {
      this.activeAnswerBlockIds.clear();
    }
    if (event.type === "text_delta" || event.type === "tool_progress") {
      // 高频增量按「种类 + 块」归并到帧末再写一次(spec §6/§10.2):每帧至多一次
      // store 写入,16KB 尾窗切片也一帧只做一遍。
      const progress = event.type === "tool_progress";
      const blockId = event.block_id;
      const piece = event.type === "tool_progress" ? event.chunk : event.delta;
      // `truncated` 只有 tool_progress 带(text_delta 无此槽)。
      const truncated = event.type === "tool_progress" && event.truncated === true;
      const key = `${progress ? "p" : "t"}\u0000${entry.turn_id}\u0000${blockId}`;
      const buffered = this.pendingFragments.get(key);
      if (buffered) {
        buffered.fragments.push({ seq: entry.timeline_seq, text: piece });
        buffered.truncated = buffered.truncated || truncated;
        buffered.seq = Math.max(buffered.seq, entry.timeline_seq);
      } else {
        this.pendingFragments.set(key, { turnId: entry.turn_id, blockId, fragments: [{ seq: entry.timeline_seq, text: piece }], truncated, seq: entry.timeline_seq, progress });
      }
      this.consumedSeq = Math.max(this.consumedSeq, entry.timeline_seq);
      this.scheduleFlush();
    } else {
      this.mutate((draft) => {
        // 结构事件是顺序屏障:同一事务先落地较早的增量,不能用更高水位吞掉它们。
        this.flushFragmentsInto(draft);
        applyEntry(draft, entry);
        draft.watermark = entry.timeline_seq;
      });
      this.consumedSeq = Math.max(this.consumedSeq, entry.timeline_seq);
    }
  }

  private scheduleFlush(): void {
    if (this.rafHandle != null) return;
    const commit = (): void => {
      if (this.rafHandle != null) globalThis.cancelAnimationFrame?.(this.rafHandle);
      this.rafHandle = null;
      if (this.flushTimer != null) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      if (this.pendingFragments.size === 0) return;
      this.mutate((draft) => this.flushFragmentsInto(draft));
    };
    this.rafHandle = requestAnimationFrame(commit);
    // 窗口被遮挡时 Chromium 可暂停 rAF;后台仍提交数据,不无限积累片段。
    this.flushTimer = setTimeout(commit, 100);
  }

  private flushFragmentsInto(draft: SessionState): void {
    let maxSeq = draft.watermark;
    for (const item of this.pendingFragments.values()) {
      // 权威快照可能只覆盖合并批次的一部分;只追加水位之后的片段。
      if (item.seq <= draft.watermark) continue;
      const text = item.fragments.filter((part) => part.seq > draft.watermark).map((part) => part.text).join("");
      applyEntry(draft, {
        timeline_seq: item.seq,
        turn_id: item.turnId,
        event: item.progress
          ? { type: "tool_progress", block_id: item.blockId, chunk: text, truncated: item.truncated }
          // 合并后块内片段号不再有意义;顺序真相是 timeline_seq。
          : { type: "text_delta", block_id: item.blockId, fragment_seq: 0, delta: text },
      });
      maxSeq = Math.max(maxSeq, item.seq);
    }
    // 所有块提交完再推进水位,避免跨块合并批次互相覆盖。
    draft.watermark = maxSeq;
    this.pendingFragments.clear();
    if (this.rafHandle != null) globalThis.cancelAnimationFrame?.(this.rafHandle);
    this.rafHandle = null;
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * 权威快照落地后重基线消费指针:快照覆盖到 `pageWatermark`,缓冲里比它更新的
   * delta 仍然要保留(那部分文本快照里没有)。这里按快照重设而不是取历史最大值
   * —— 换 epoch 后 seq 可能从更小的数重新开始。
   */
  private rebaseConsumed(pageWatermark: number): void {
    // 取 max 而不是直接重设:这一页可能被 applySnapshot 当陈旧页整页丢弃(那时
    // draft.watermark 停在更高处),把消费指针拉到更低就会让重复/丢失判定错位。
    // 换 epoch 时 applySnapshot 先把 draft.watermark 重设,这里自然跟着降。
    let seq = Math.max(pageWatermark, this.stateGet.watermark);
    for (const item of this.pendingFragments.values()) seq = Math.max(seq, item.seq);
    this.consumedSeq = seq;
  }

  private scheduleResnapshot(): void {
    const at = Date.now();
    if (at - this.lastResnapshotAt < RESNAPSHOT_DEBOUNCE_MS) return;
    this.lastResnapshotAt = at;
    void this.resnapshot();
  }

  /** 快照重建(attach/缺口校正后的权威对齐)。 */
  async resnapshot(): Promise<void> {
    try {
      const page = await transport.timelinePage(this.seed, `?limit=${SNAPSHOT_LIMIT}`);
      this.mutate((draft) => {
        applySnapshot(draft, page);
      });
      this.rebaseConsumed(page.snapshot?.watermark ?? 0);
      this.loadError[1](false);
    } catch {
      // 快照失败不致命:流还在,下一次触发再试。
    }
  }

  // ── 投影事件(刷新信号,宿主转发) ─────────────────────────────────────────────

  /** 前端只把投影事件当刷新信号;数据一律走 approvals RPC / sessions 列表。 */
  private applyProjection(streamKey: unknown, payload: unknown): void {
    const delta = readProjection(streamKey, payload);
    if (!delta.channel || !delta.kind) return;
    if (delta.channel === "conversation") {
      if (delta.kind === "turn_started") {
        this.activeTurnStartedAt = now();
        this.activeAnswerBlockIds.clear();
        this.activeOutputStartedAt = null;
        this.activeOutputEndedAt = null;
      }
      if (delta.kind === "assistant_block_sealed" || delta.kind === "turn_finished") {
        const usage = delta.body.usage as UsageInfo | null | undefined;
        if (usage != null) this.updateComposerUsage(usage);
        if (delta.kind === "turn_finished") {
          this.activeTurnStartedAt = null;
          this.activeAnswerBlockIds.clear();
          void this.refreshContextLength();
        }
      }
    }
    for (const action of projectionActions(delta)) {
      switch (action) {
        case "activity":
          // `state` 在内层 data 里(双层 tag/content),读错层就是静默无信号。
          this.activity[1](normalizeActivity(delta.body.state, "projection"));
          break;
        case "approvals":
          void this.refreshApprovals();
          break;
        case "todos":
          void this.refreshTodos();
          break;
        case "compacted": {
          const slots = this.stateGet.slots;
          const anchor = slots.length > 0 ? slots[slots.length - 1]!.key : null;
          this.compactedAfter[1](anchor);
          this.compact[1]((current) => reduceCompact(current, "compacted", delta.body, now()));
          break;
        }
        case "compact_started":
        case "compact_progress":
        case "compact_finished": {
          this.compact[1]((current) => reduceCompact(current, action, delta.body, now()));
          break;
        }
        case "sessions":
          if (delta.kind === "title_changed" && typeof delta.body.title === "string") {
            // v2 Meta SSE carries the value, so update the active tab and sidebar
            // immediately without waiting for the periodic session.list poll.
            this.applySessionMeta({ title: delta.body.title });
            this.onSessionTitleChanged?.(delta.body.title);
          } else {
            this.onSessionsChanged?.();
          }
          break;
        case "session_deleted":
          this.onSessionDeleted?.();
          break;
      }
    }
  }

  private updateComposerUsage(usage: UsageInfo): void {
    // Measure from the first to last streamed answer fragment, excluding tool and
    // user-wait time. Fall back to the turn interval for replay/history-only paths.
    const durationMs = this.activeOutputStartedAt != null && this.activeOutputEndedAt != null
      ? this.activeOutputEndedAt - this.activeOutputStartedAt
      : this.activeTurnStartedAt == null ? null : now() - this.activeTurnStartedAt;
    const elapsedSeconds = durationMs == null ? null : Math.max(0.001, durationMs / 1_000);
    // 服务端 usage 的 prompt_tokens 就是这一轮真正发出去的上下文(系统提示 + 工具
    // schema + 历史),直接当占用真值;它只统计到本轮 prompt,答案那部分要等下一轮
    // 才进 prompt,所以这个表盘天然滞后一轮。
    this.measuredContextTokens = usage.prompt_tokens;
    this.composerMetrics[1]((current) => ({
      ...current,
      tokensPerSecond: elapsedSeconds == null ? current.tokensPerSecond : usage.completion_tokens / elapsedSeconds,
      cacheHitPercent: usage.cache_usage_reported === false
        ? null
        : cacheHitPercent(usage) ?? current.cacheHitPercent,
      // 反映上一轮为准:端点这轮没报 extras 就清空,不留陈旧的芯片。
      extras: usage.extras ?? {},
    }));
    this.publishContextPercent();
  }

  /** 百分比只有一个出口:分子是真值,没有真值(首轮之前)就不显示。 */
  private publishContextPercent(): void {
    const tokens = this.measuredContextTokens;
    const length = this.contextLength;
    this.composerMetrics[1]((current) => ({
      ...current,
      contextPercent: tokens == null || length == null || !Number.isFinite(length) || length <= 0
        ? null
        : Math.min(100, (tokens / length) * 100),
    }));
  }

  /** 只取窗口这一个数当百分比分母;分子不由这里产生(来自 usage 流)。 */
  private async refreshContextLength(): Promise<void> {
    if (this.disposed) return;
    const refreshId = ++this.contextRefreshId;
    try {
      const config = await transport.rpc<ConfigDto>("config.load");
      if (this.disposed || refreshId !== this.contextRefreshId) return;
      const length = config?.contextLength;
      if (length != null && Number.isFinite(length) && length > 0) this.contextLength = length;
      this.publishContextPercent();
    } catch {
      // Keep the last known window; metrics are an optional HUD.
    }
  }

  async refreshActivity(): Promise<void> {
    try {
      const bootstrap = (await this.host().sessionBootstrap(this.seed)) as any;
      const control = bootstrap?.control?.state ?? {};
      this.activity[1](normalizeActivity(control.activity, "domain"));
    } catch {
      // best-effort;activity 由投影事件持续修正。
    }
  }

  // ── 待办(todo.list 单源) ────────────────────────────────────────────────────

  /** RPC remains authoritative. V2 facts invalidate it; legacy dashboard events
   * are not broadcast. Coalesce bursts, retaining a trailing read if a mutation
   * arrives during an in-flight request. Never commit a superseded response. */
  refreshTodos(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.todoRefreshPending = true;
    if (this.todoRefresh != null) return this.todoRefresh;
    this.todoRefresh = this.drainTodoRefresh().finally(() => {
      this.todoRefresh = null;
      // An invalidation can arrive between the last read and this finalizer.
      if (this.todoRefreshPending && !this.disposed) void this.refreshTodos();
    });
    return this.todoRefresh;
  }

  private async drainTodoRefresh(): Promise<void> {
    while (this.todoRefreshPending && !this.disposed) {
      this.todoRefreshPending = false;
      try {
        const result = await transport.rpc<Record<string, unknown>>("todo.list", {}, this.seed);
        if (this.disposed || this.todoRefreshPending) continue;
        if (!Array.isArray(result?.items)) throw new Error("todo.list response is missing items");
        writeStable(this.todos, result.items as TodoItemWire[]);
      } catch (error) {
        // Preserve the last successful list; make failures visible in diagnostics.
        if (!this.disposed) console.warn("[qaqh-webui] todo.list refresh failed", error);
      }
    }
  }

  // ── 审批(单源:approvals RPC) ───────────────────────────────────────────────

  async refreshApprovals(): Promise<void> {
    let list: ApprovalView[];
    try {
      list = await transport.approvals(this.seed);
    } catch {
      return; // best-effort:下一轮信号再取
    }
    const previous = this.pending[0]();
    const next = Array.isArray(list) ? list : [];
    // 内容未变不写信号:每次刷新都灌新数组会让授权卡整棵子树按身份重建
    // (反复重挂 = 焦点被抢 + 图形与内存持续增长),而 UI 看上去毫无变化。
    writeStable(this.pending, next);
    this.recordWaitTransition(previous, next);
    this.activity[1](next.length > 0 ? "waiting_user" : this.activityIsWorking() ? "working" : "idle");
  }

  private activityIsWorking(): boolean {
    return this.activity[0]() === "working";
  }

  /** 0→N 开区间 / N→0 闭区间,挂到当前运行回合(spec D3:已工作扣除等待)。 */
  private recordWaitTransition(previous: ApprovalView[], next: ApprovalView[]): void {
    if (previous.length === 0 && next.length > 0) {
      const kind = next[0]!.kind === "ask" || next[0]!.kind === "plan" ? "ask" : "approval";
      this.waitFrom = { kind, at: now() };
    } else if (previous.length > 0 && next.length === 0 && this.waitFrom) {
      const wait: Wait = { turnKey: this.stateGet.activeTurnKey, kind: this.waitFrom.kind, from: this.waitFrom.at, to: now() };
      this.mutate((draft) => {
        draft.waits.push(wait);
      });
      this.waitFrom = null;
    }
  }

  async respondApproval(challengeId: string, decision: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await transport.respondApproval(this.seed, challengeId, decision, payload);
    } finally {
      // 宿主 challenge 一次性消费；daemon 拒绝或 IPC 短暂失败时也必须重取，
      // 让仍然 pending 的交互获得新 challenge，避免界面卡在已消费的旧 ID 上。
      await this.refreshApprovals();
    }
  }

  // ── 动作 ────────────────────────────────────────────────────────────────────

  async sendMessage(text: string): Promise<void> {
    const attachments = this.pendingAttachments[0]()
      .filter((item) => item.state === "ready" && item.reference != null)
      .map((item) => item.reference as ContentRef);
    await transport.command("conversation", {
      channel: "conversation",
      type: "conversation_send_message",
      text,
      images: [],
      as_system: false,
      attachments,
    }, this.seed);
    // 投递失败会抛出,附件保持原样让用户重试。
    this.pendingAttachments[1]([]);
  }

  /**
   * 选附件并逐个上传。字节读取与上传都在宿主侧完成(见宿主 `upload_attachment`),
   * 这里只维护 chip 状态。单个失败不影响其余:该 chip 转 failed 并留在列表里。
   */
  async addAttachments(): Promise<void> {
    const paths = await transport.pickAttachments();
    if (paths.length === 0) return;
    const known = new Set(this.pendingAttachments[0]().map((item) => item.id));
    const added: PendingAttachment[] = [];
    for (const path of paths) {
      if (known.has(path)) continue;
      known.add(path);
      added.push({
        id: path,
        name: attachmentName(path),
        size: 0,
        mediaType: "",
        state: "uploading",
        reference: null,
        error: null,
      });
    }
    if (added.length === 0) return;
    this.pendingAttachments[1]((current) => [...current, ...added]);
    await Promise.all(added.map(async (item) => {
      try {
        const uploaded = await transport.uploadAttachment(this.seed, item.id);
        this.patchAttachment(item.id, {
          name: uploaded.name,
          size: uploaded.size,
          mediaType: uploaded.media_type,
          state: "ready",
          reference: {
            content_id: uploaded.content_id,
            media_type: uploaded.media_type,
            sha256: uploaded.sha256,
            truncated: uploaded.truncated,
          },
        });
      } catch (error) {
        this.patchAttachment(item.id, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }

  removeAttachment(id: string): void {
    this.pendingAttachments[1]((current) => current.filter((item) => item.id !== id));
  }

  private patchAttachment(id: string, patch: Partial<PendingAttachment>): void {
    this.pendingAttachments[1]((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async cancelTurn(): Promise<void> {
    await transport.command("conversation", { channel: "conversation", type: "conversation_cancel" }, this.seed);
  }

  /**
   * 手动压缩上下文。ack 只代表进队,所以先乐观置 running,否则按钮点了要等
   * 第一帧过程事件才有反馈;真实终态以 `compact_finished` / `compaction_applied`
   * 为准。投递失败只是个失败态,原因只在控制台(`compact_finished` 不带原因)。
   */
  async compactContext(): Promise<void> {
    this.compact[1]({ phase: "running", compactId: null, turnsTotal: null, turnsKeeping: null, summary: "" });
    try {
      await transport.command("conversation", { channel: "conversation", type: "conversation_compact" }, this.seed);
    } catch (error) {
      console.warn("[compact] 压缩命令投递失败", error);
      this.compact[1]({ phase: "failed" });
    }
  }

  async createSession(): Promise<void> {
    await transport.command("control", { channel: "control", type: "session_create", close_current: false });
  }

  /** 向上翻页(spec §14.2)。返回是否真的加载了内容(调用方做滚动补偿)。 */
  async loadOlder(): Promise<boolean> {
    const state = this.stateGet;
    if (this.loadingOlder[0]() || !state.hasMore || state.oldestIndex == null) return false;
    this.loadingOlder[1](true);
    this.loadError[1](false);
    try {
      const page = await transport.timelinePage(this.seed, `?limit=${PAGE_LIMIT}&before_index=${state.oldestIndex}`);
      this.mutate((draft) => {
        prependPage(draft, page);
      });
      return true;
    } catch {
      this.loadError[1](true); // 顶部「加载失败,点击重试」,不自动重试
      return false;
    } finally {
      this.loadingOlder[1](false);
    }
  }

  /**
   * 窗口淘汰(spec §14.1):超出 `window` 且远在视口上方的最旧回合替换为等高
   * 占位,并释放其回合数据——只换占位不删数据的话,翻页越深 turns 全量文本
   * 越攒越多(常驻内存只增不减)。返回被淘汰的 slot key 供视图回填高度。
   */
  evictOutOfView(
    window: number,
    screens: number,
    offsetTopOf: (key: string) => number | null,
    viewportTop: number,
    viewportHeight: number,
  ): string[] {
    let evicted: string[] = [];
    this.mutate((draft) => {
      evicted = evictForWindow(draft, window, screens, offsetTopOf, viewportTop, viewportHeight);
    });
    return evicted;
  }

  /**
   * 时间线展开态(spec §7.3)。MUST 走 setter:Solid 2 的 store 代理直写
   * (`state[0].turns[k].expanded = …`)会被静默丢弃,读回来还是旧值。
   */
  toggleTurnExpanded(key: string): void {
    this.mutate((draft) => {
      const turn = draft.turns[key];
      if (turn) turn.expanded = !turn.expanded;
    });
  }

  /** 回合淘汰占位高度回填(由视图量完布局后一次写入整段;逐格写会通知每个下标)。 */
  setPlaceholderHeights(heights: Array<[key: string, height: number]>): void {
    if (heights.length === 0) return;
    const byKey = new Map(heights);
    this.mutate((draft) => {
      fillGapHeights(draft, byKey);
    });
  }

  /** sessions 列表驱动:标题 + 后台「有新回复」点(运行态走 activity 信号,不从这里取)。 */
  applySessionMeta(meta: { title?: string | null; turn_count?: number }): void {
    if (typeof meta.title === "string" && meta.title) this.title[1](meta.title);
    if (typeof meta.turn_count === "number") {
      const known = this.lastTurnCount;
      if (known != null && meta.turn_count > known) this.hasNewReply[1](true);
      this.lastTurnCount = meta.turn_count;
    }
  }
}


/**
 * 内容未变则不写信号:每次刷新都灌新对象会让 `For` 按身份重建整棵子树
 * (授权卡反复重挂 = 焦点被抢 + 反应图形与内存只增不减),而 UI 毫无变化。
 */
function writeStable<T>(signal: readonly [() => T, (value: T) => void], next: T): void {
  const current: T = signal[0]();
  if (current === next) return;
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  signal[1](next);
}
