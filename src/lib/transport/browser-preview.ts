/**
 * Dev-only browser adapter for inspecting the real WebUI from Codex's browser.
 * Requests go through Vite's same-origin proxy to the Tauri host; the daemon
 * credential and approval challenge store remain inside Rust.
 */
import type {
  Ack,
  ApprovalView,
  StreamHandlers,
  TimelinePageResponse,
  TimelineStatusWire,
  TransportBackend,
  TauriHostSurface,
} from "./backend";

type HostDiagnostics = {
  onIncompatible?: (details: Record<string, any>) => void;
  onHostError?: (message: string) => void;
};

type BridgeEvent = { event: string; payload: unknown };

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/__qaqh_preview/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const body = await response.json() as { error?: string } | T;
  if (!response.ok) {
    const message = typeof body === "object" && body != null && "error" in body
      ? String(body.error)
      : `browser preview bridge returned ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function subscribeEvents(onEvent: (event: BridgeEvent) => void, onError?: () => void): () => void {
  const source = new EventSource("/__qaqh_preview/events");
  const names = [
    "timeline://entry",
    "timeline://status",
    "timeline://snapshot",
    "projection://event",
    "projection://reset",
    "conn://incompatible",
    "conn://error",
    "conn://liveness",
  ];
  for (const name of names) {
    source.addEventListener(name, (message) => {
      try {
        onEvent({ event: name, payload: JSON.parse((message as MessageEvent<string>).data) as unknown });
      } catch {
        // Ignore malformed preview frames; the host emits JSON-only payloads.
      }
    });
  }
  source.onerror = () => onError?.();
  return () => source.close();
}

export class BrowserPreviewTransport implements TransportBackend, TauriHostSurface {
  private activeSeed: string | null = null;

  sessions(): Promise<any[]> {
    return invoke<any[]>("session_list");
  }

  async attach(seed: string, limit?: number): Promise<void> {
    await invoke<void>("attach", { seed, limit: limit ?? null });
    this.activeSeed = seed;
  }

  approvals(sessionId: string): Promise<ApprovalView[]> {
    return invoke<ApprovalView[]>("pending_approvals", { seed: sessionId });
  }

  async respondApproval(sessionId: string, challengeId: string, decision: string, payload: Record<string, unknown> = {}): Promise<null> {
    await invoke<void>("respond_approval", { seed: sessionId, challengeId, decision, payload });
    return null;
  }

  command(channel: "control" | "conversation", command: Record<string, unknown>, sessionId?: string): Promise<Ack> {
    const type = typeof command.type === "string" ? command.type : "";
    if (channel === "conversation" && type === "conversation_send_message") {
      return invoke<Ack>("send_message", { seed: sessionId ?? this.requireSeed("send_message"), text: command.text ?? "" });
    }
    if (channel === "conversation" && type === "conversation_cancel") {
      return invoke<Ack>("cancel_turn", { seed: sessionId ?? this.requireSeed("cancel_turn") });
    }
    if (channel === "control" && type === "session_create") return invoke<Ack>("create_session");
    return Promise.reject(new Error(`command not allowed in browser preview: ${channel}/${type || "(untyped)"}`));
  }

  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const scoped = sessionId == null ? params : { ...params, session_id: sessionId };
    return invoke<T>("service_rpc", { method, params: scoped });
  }

  timelinePage(seed: string, query = ""): Promise<TimelinePageResponse> {
    const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
    const limit = params.get("limit");
    const beforeIndex = params.get("before_index");
    return invoke<TimelinePageResponse>("timeline_page", {
      seed,
      limit: limit != null && limit !== "" ? Number(limit) : null,
      beforeIndex: beforeIndex != null && beforeIndex !== "" ? Number(beforeIndex) : null,
    });
  }

  subscribe(handlers: StreamHandlers): Promise<() => void> {
    const unlisten = subscribeEvents(({ event, payload }) => {
      if (event === "timeline://entry") {
        const data = payload as { session_id?: string; entry?: Record<string, any> };
        if (typeof data.session_id === "string" && data.entry != null) handlers.onTimelineEntry(data.session_id, data.entry);
      } else if (event === "timeline://status") {
        handlers.onTimelineStatus(payload as TimelineStatusWire);
      } else if (event === "timeline://snapshot") {
        handlers.onTimelineSnapshot(payload as TimelinePageResponse);
      } else if (event === "projection://event") {
        const data = payload as Record<string, any>;
        handlers.onProjectionEvent(typeof data.session_id === "string" ? data.session_id : "", data);
      } else if (event === "projection://reset") {
        const data = payload as Record<string, any>;
        handlers.onProjectionReset(typeof data.session_id === "string" ? data.session_id : "", data);
      } else if (event === "conn://incompatible") {
        handlers.onIncompatible((payload ?? {}) as Record<string, any>);
      } else if (event === "conn://error") {
        handlers.onHostError(String((payload as { message?: string } | null)?.message ?? "host error"));
      }
    }, () => handlers.onHostError("browser preview event stream disconnected"));
    return Promise.resolve(unlisten);
  }

  sessionBootstrap(seed: string): Promise<unknown> {
    return invoke("session_bootstrap", { seed });
  }

  timelineStatus(seed: string): Promise<TimelineStatusWire | null> {
    return invoke<TimelineStatusWire | null>("timeline_status", { seed });
  }

  async streamsRetry(seed?: string): Promise<void> {
    await invoke<void>("streams_retry", { seed: seed ?? null });
  }

  stopStaleDaemon(): Promise<"stopping" | "busy" | "unsupported"> {
    return invoke("stop_stale_daemon");
  }

  private requireSeed(action: string): string {
    if (this.activeSeed == null) throw new Error(`${action} needs an attached session`);
    return this.activeSeed;
  }
}

export async function listenBrowserPreviewDiagnostics(handlers: HostDiagnostics): Promise<() => void> {
  return subscribeEvents(({ event, payload }) => {
    if (event === "conn://incompatible") handlers.onIncompatible?.((payload ?? {}) as Record<string, any>);
    if (event === "conn://error") handlers.onHostError?.(String((payload as { message?: string } | null)?.message ?? "host error"));
  });
}

export async function openBrowserPreviewUrl(url: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

