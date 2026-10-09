/**
 * 开发夹具:真实 `App` + 假宿主 IPC,在浏览器里跑设置浮层的读写语义。
 *
 * 为什么要有它:设置页的唯一通路是 Tauri 的 `service_rpc` 白名单,浏览器里既没有
 * daemon 也没有宿主。这里把宿主替身做成「白名单式」的——只认宿主真允许的方法,
 * 其余抛错,于是 fixture 里能验的是语义而不是便利:`config.save` 收到什么 patch,
 * 就是 webview 真的发出去了什么。
 *
 * 不进产品构建:vite 构建入口是 `index.html`,本文件只被 `/settings-check.html` 引用。
 */
import { render } from "@solidjs/web";
import App from "./app/App";
import type { ConfigDto } from "./api/qaqh/ConfigDto";
import { simMemorySnapshot } from "./lib/memwatch-sim";
import { openDevConsole } from "./lib/devmode";
import { openSettings } from "./settings/store";
import { openSession } from "./tabs/store";
import type { McpServerDto } from "./api/qaqh/McpServerDto";
import type { LspServerDto } from "./api/qaqh/LspServerDto";

type RpcCall = { method: string; params: Record<string, unknown> };

const baseConfig = (): ConfigDto => ({
  model: "ox-alpha-free",
  baseUrl: "https://opencode.ai/zen/go/v1",
  wire: "openai",
  maxTokens: 96000,
  contextLength: 1000000,
  reasoningEffort: "max",
  autoCompactThreshold: 0.95,
  permissionLevel: 2,
  apiKey: "****",
  lang: null,
  fontFamily: "",
  theme: null,
  notificationsEnabled: true,
  activeProfile: "default",
  profiles: ["default", "fast"],
  complianceEnabled: false,
  exec: { defaultShell: null },
  sessionIdleUnloadSecs: 0,
  subagent: {
    model: "om-two",
    baseUrl: "https://other.example/compat/v1",
    apiKey: "",
    apiKeySet: false,
    maxTokens: 4096,
    timeoutSecs: 120,
    defaultTools: ["read", "write"],
    maxDepth: 1,
    messageInFlightPerPair: 16,
    messageOutboundPerSender: 1024,
  },
  mcp: {
    enabled: true,
    idleShutdownSecs: 300,
    servers: [
      {
        name: "context7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "ctx7"],
        env: { KEY: "${secret:ctx7}" },
        url: "",
        headers: {},
        tools: null,
        resourcesEnabled: false,
        defaultTimeoutSecs: 30,
        maxConcurrentCalls: 8,
        cwd: "",
      } satisfies McpServerDto,
    ],
  },
  lsp: {
    enabled: false,
    idleShutdownSecs: 600,
    servers: [
      {
        name: "rust-analyzer",
        command: "rust-analyzer",
        args: [],
        env: {},
        extensions: ["rs"],
        startupTimeoutSecs: 20,
        defaultTimeoutSecs: 60,
      } satisfies LspServerDto,
    ],
  },
  tokenizerPath: null,
});

const probe = {
  calls: [] as RpcCall[],
  saves: [] as Record<string, unknown>[],
  config: baseConfig(),
  /** 置 true 后 LAN 重启请求返回 `daemon_busy`,用来走查强制重启确认面板。 */
  lanBusy: false,
};

/** 假宿主的 merge patch 应用:与 daemon 同语义——缺字段不动,`"****"`/空串密钥保持。 */
function applyMergePatch(target: ConfigDto, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "subagent" && value != null && typeof value === "object") {
      Object.assign(target.subagent, value as Record<string, unknown>);
      continue;
    }
    if (key === "apiKey" && (value === "****" || value === "")) continue;
    (target as Record<string, unknown>)[key] = value;
  }
}

function serviceRpc(method: string, params: Record<string, unknown>): unknown {
  probe.calls.push({ method, params });
  switch (method) {
    case "config.load":
      return structuredClone(probe.config);
    case "config.save":
      probe.saves.push(structuredClone(params));
      applyMergePatch(probe.config, params);
      return null;
    case "profile.save_current":
      if (!probe.config.profiles.includes(String(params.name))) {
        probe.config.profiles = [...probe.config.profiles, String(params.name)];
      }
      return null;
    case "profile.apply":
      probe.config.activeProfile = String(params.name);
      return null;
    case "profile.delete":
      probe.config.profiles = probe.config.profiles.filter((name) => name !== String(params.name));
      return null;
    // 与宿主白名单同调(commands.rs:SERVICE_METHODS):这几条现在是真的放行的方法,
    // 夹具不接就等于替真宿主放行它不曾放行过的东西——快照用 memwatch-sim 造。
    case "daemon.version":
      return "0.0.0-fixture";
    case "session.list":
      return [];
    case "workspace.list":
      // 裸数组(service.rs:417 `Ok(Value::Array(items))`),与 `todo.list` 的
      // `{ items }` 不同形;侧栏按数组直接 `.map`,给成对象会当场halt掉反应式系统。
      return [];
    // `?dev=1` 会真开一个标签,store 激活时按宿主白名单拉待办;夹具缺这条就会刷一条
    // 告警出来(真宿主放行,见 commands.rs:SERVICE_METHODS)。
    case "todo.list":
      return { items: [] };
    case "diagnostics.memory.start":
      return { enabled: true, started_at_ms: Date.now() };
    case "diagnostics.memory.stop":
      return { enabled: false };
    case "diagnostics.memory.snapshot":
      return simMemorySnapshot(typeof params.after_sequence === "number" ? params.after_sequence : null);
    default:
      // 宿主白名单(commands.rs 的 SERVICE_METHODS)之外的方法在这里也必须失败,
      // 否则夹具会替真实宿主放行它不曾放行的东西。
      throw new Error(`service method not allowed in fixture: ${method}`);
  }
}

/**
 * 假宿主的 daemon 局域网面:字段与 `src-tauri/src/lan.rs` 的 lan_view 同形。
 * 夹具验的是前端语义与观感,所以「重启」只翻转内存状态,不真起进程。
 */
const lan = {
  running: true,
  active: false,
  endpoint: "http://127.0.0.1:61746",
  lan_endpoint: null as string | null,
  tls_fingerprint: null as string | null,
  pid: 45368,
};

const lanView = (): Record<string, unknown> => ({
  ...lan,
  daemon_version: "2.0.0-beta.3",
  protocol_version: 1,
  app_protocol_version: 1,
});

const lanRestartGuard = (): void => {
  if (probe.lanBusy) throw new Error("daemon_busy");
};

function lanEnable(bindIp: string, port: number | null): Record<string, unknown> {
  lanRestartGuard();
  const host = bindIp.trim() === "" ? "192.168.1.23" : bindIp.trim();
  lan.active = true;
  lan.running = true;
  lan.pid += 1;
  lan.lan_endpoint = `https://${host}:${port ?? 64413}`;
  lan.tls_fingerprint = "sha256:8a5f1c2b9d4e7f60aa12b34c5d6e7f80";
  return lanView();
}

function lanDisable(): Record<string, unknown> {
  lanRestartGuard();
  lan.active = false;
  lan.pid += 1;
  lan.lan_endpoint = null;
  lan.tls_fingerprint = null;
  return lanView();
}

const pairingTicket = (): Record<string, unknown> => {
  const baseUrl = (lan.lan_endpoint ?? "https://192.168.1.23:64413").replace(/\/$/, "");
  return {
    qr_payload: JSON.stringify({
      v: 1,
      kind: "qaqh-pair",
      base_url: baseUrl,
      pairing_token: "fixture-one-time-token",
      tls_fp: lan.tls_fingerprint ?? "",
      host_name: "QAQH-DEV",
    }),
    expires_in_ms: 120_000,
    base_url: baseUrl,
  };
};

const callbacks = new Map<number, (payload: unknown) => void>();
let nextCallbackId = 1;

const internals = {
  metadata: { currentWindow: { label: "main" }, windowLabels: { main: 1 } },
  transformCallback(callback: (payload: unknown) => void, once = false): number {
    void once;
    const id = nextCallbackId;
    nextCallbackId += 1;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback(id: number): void {
    callbacks.delete(id);
  },
  async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (cmd === "service_rpc") return serviceRpc(String(args.method), (args.params ?? {}) as Record<string, unknown>);
    if (cmd === "session_list") return [];
    if (cmd === "timeline_status") return null;
    if (cmd === "daemon_lan_status") return lanView();
    if (cmd === "daemon_lan_enable") return lanEnable(String(args.bindIp ?? ""), (args.port as number | null | undefined) ?? null);
    if (cmd === "daemon_lan_disable") return lanDisable();
    if (cmd === "pairing_create") return pairingTicket();
    if (cmd === "app_version") {
      return { version: "2.0.0-beta.4", commit: "fixture0", display: "2.0.0-beta.4-fixture0" };
    }
    // 界面进程组(commands.rs::host_process_group 的替身)。形状照 procgroup.rs:
    // 角色由「引擎」自报、字节量逐成员给;最后那条 utility 故意读不到,用来验
    // 「失败不静默跳过」——它该进 excluded 而不是被少加。
    if (cmd === "host_process_group") {
      const wave = Math.round(Math.sin(Date.now() / 7_000) * 3_000_000);
      return {
        source: "webview2.pids+psapi",
        error: null,
        members: [
          { pid: 4100, kind: "browser", resident_bytes: 96_000_000 + wave, private_bytes: 88_000_000, error: null },
          { pid: 4120, kind: "renderer", resident_bytes: 168_000_000 + wave * 2, private_bytes: 150_000_000, error: null },
          { pid: 4131, kind: "renderer", resident_bytes: 42_000_000, private_bytes: 36_000_000, error: null },
          { pid: 4108, kind: "gpu", resident_bytes: 54_000_000, private_bytes: 47_000_000, error: null },
          { pid: 4144, kind: "utility", resident_bytes: null, private_bytes: null, error: "OpenProcess(4144) failed: 拒绝访问" },
        ],
      };
    }
    // 壳自己的内存计数(commands.rs::host_memory 的替身)。字段与 psapi 分支同形,
    // 让「本机」面板在浏览器里也有数可拍;private 给值、virtual 给 null,顺带验一次
    // 「缺测显示 —」而不是冒充 0。
    if (cmd === "host_memory") {
      const resident = 214_000_000 + Math.round(Math.sin(Date.now() / 9_000) * 4_000_000);
      return {
        resident_bytes: resident,
        private_bytes: resident - 18_000_000,
        virtual_bytes: null,
        peak_resident_bytes: 268_000_000,
        source: "fixture.psapi",
        error: null,
      };
    }
    if (cmd === "devices_list") {
      return {
        devices: [
          {
            device_id: "dev_seed_1",
            name: "我的手机",
            platform: "mobile",
            scope: "interact",
            created_at_ms: Date.now() - 86_400_000,
            last_seen_ms: Date.now() - 3_600_000,
          },
        ],
      };
    }
    // 插件命令(event/opener/window)在夹具里都是空转:结构合法即可。
    return null;
  },
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __qaqhProbe?: typeof probe;
  }
}

window.__TAURI_INTERNALS__ = internals;
window.__qaqhProbe = probe;

const root = document.getElementById("root");
if (root != null) render(() => <App />, root);

/**
 * `?dev=1`:给开发者控制台铺一层「可拍的真状态」——开一个假会话标签(活动面板就
 * 有 store 可读)、打开设置、并解锁控制台。默认不开:既有断言与基线都不受影响。
 * 走的是真 `App` + 真 `TauriTransport`,所以事件流面板在这里能看到埋点真的记到了
 * 收发(stress.tsx 那条路把 `transport.rpc` 整个替掉了,绕过埋点)。
 */
const devHarness = new URLSearchParams(window.location.search).get("dev") === "1";
if (devHarness) {
  void openSession("seed_dev_preview");
  void openSettings();
  openDevConsole();
}
