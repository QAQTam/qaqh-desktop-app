/**
 * 标签页与会话路由(spec §5)。
 *
 * 一个标签 = 一个会话;关闭标签 = 退订宿主事件,不取消运行中的 Turn、不取消
 * 待处理授权(后端常驻,D2:本阶段无法重新打开已关闭标签)。
 * 非活动标签卸载 DOM,仅保留 store 数据(§5.3)。
 *
 * 会话创建(spec §5.1「+」):经控制通道 SessionCreate,轮询 sessions 列表
 * 找出新 seed。宿主模式下 SessionCreate 不要求 active seed,空会话也可创建。
 */
import { createSignal, createStore } from "solid-js";
import { transport } from "../lib/transport";
import { STR } from "../lib/strings";
import { SessionStore } from "../session/store";
import { toast } from "../ui/toast";

export interface Tab {
  id: string;
  seed: string;
  store: SessionStore;
}

const [tabs, setTabs] = createSignal<Tab[]>([]);
const [activeId, setActiveId] = createSignal<string | null>(null);
const [bootError, setBootErrorSignal] = createSignal<string | null>(null);
// setBootError 由本模块内部与 App 兜底路径共用;导出名见文件底部。
const [creating, setCreating] = createSignal(false);
/**
 * 侧栏卡片字段 = 宿主 `SidebarSession`(src-tauri/src/commands.rs)的同名镜像:
 * 两边改一边,`commands.rs` 的 sidebar_projection_* 会红。
 */
export type SidebarSession = {
  session_id: string;
  title?: string | null;
  cwd?: string | null;
  updated_at?: number;
  archived?: boolean;
  /**
   * 回合在跑,或卡在用户这一侧(授权/ask/计划评审)。宿主按 `SessionRunStatus`
   * 折算(`commands.rs:session_is_busy`),不再是从前的 `running`(进程存在性)。
   */
  busy?: boolean;
  /** 会话轮次数:后台标签状态点用它判断「跑过东西但没在跑」(§5.2)。 */
  turn_count?: number;
  workspace_id?: string | null;
};
export type SidebarWorkspace = { id: string; title: string; path: string; order: number; missing_dir?: boolean };
const [sessionCatalog, setSessionCatalog] = createSignal<SidebarSession[]>([]);
const [workspaceCatalog, setWorkspaceCatalog] = createSignal<SidebarWorkspace[]>([]);
/**
 * 新建会话的目标工作区(`cwd`),null = 未指定 → daemon 默认(未分组)。
 *
 * 只作用于**新建**:已开会话的 cwd 钉在 `SessionMeta.cwd` 上,改它要走
 * `workspace.set`,是另一条路径。选择保持粘性——建完不重置,输入区一直显示
 * 当前目标,免得连开几个会话时猜「这次会落哪」。
 */
const [newSessionCwd, setNewSessionCwd] = createSignal<string | null>(null);
const [drafts, setDrafts] = createStore<Record<string, string>>({});
/** 焦点令牌:切标签/新建时 +1,Composer 响应后聚焦。 */
const [focusToken, setFocusToken] = createSignal(0);
/** Serialize singleton-host attach calls; rapid tab changes must settle on the latest tab. */
let activationQueue: Promise<void> = Promise.resolve();

export { tabs, activeId, bootError, creating, focusToken, sessionCatalog, workspaceCatalog, newSessionCwd, setNewSessionCwd };
export const setBootError = (value: string | null): void => {
  setBootErrorSignal(value);
};
export const activeTab = (): Tab | null => tabs().find((tab) => tab.id === activeId()) ?? null;
export const draftOf = (seed: string): string => drafts[seed] ?? "";
export const setDraftOf = (seed: string, value: string): void => {
  setDrafts((draft) => { draft[seed] = value; });
};

function addTab(seed: string): Tab {
  const existing = tabs().find((tab) => tab.seed === seed);
  if (existing != null) return existing;
  const tab: Tab = { id: `tab-${seed}`, seed, store: new SessionStore(seed) };
  // 会话元数据变更接给标签层:store 只有已 attach 的那条流,所以这里只管活动
  // 会话的即时刷新,后台会话仍靠 pollSessions 的列表重拉兜底。
  tab.store.onSessionsChanged = () => { void pollSessions(); };
  tab.store.onSessionTitleChanged = (title) => {
    setSessionCatalog((list) => list.map((item) =>
      String(item.session_id) === seed ? { ...item, title } : item,
    ));
  };
  tab.store.onSessionDeleted = () => { void dropSession(seed); };
  setTabs((list) => [...list, tab]);
  return tab;
}

/** 激活标签:宿主 attach 切 active seed + 重建流 → 该 store 订阅,其余退订。 */
export async function activateTab(tab: Tab): Promise<void> {
  setActiveId(tab.id);
  setFocusToken(focusToken() + 1);
  for (const other of tabs()) {
    if (other.id !== tab.id) other.store.deactivate();
  }
  const activation = activationQueue.catch(() => {}).then(async () => {
    // A rapid later click supersedes queued work before it can attach.
    if (activeId() !== tab.id) return;
    try {
      await tab.store.activate();
      if (activeId() !== tab.id) {
        tab.store.deactivate();
        return;
      }
      setBootError(null);
    } catch (error) {
      if (activeId() === tab.id) setBootError(String(error instanceof Error ? error.message : error));
    }
  });
  activationQueue = activation;
  await activation;
}

export async function openSession(seed: string): Promise<void> {
  const tab = addTab(seed);
  await activateTab(tab);
}

export async function closeTab(tabId: string): Promise<void> {
  const list = tabs();
  const index = list.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  const tab = list[index]!;
  const wasActive = activeId() === tabId;
  setTabs(list.filter((item) => item.id !== tabId));
  setDrafts((draft) => { delete draft[tab.seed]; });
  tab.store.dispose();
  if (wasActive) {
    const next = list[index - 1] ?? list[index + 1] ?? null;
    if (next != null) await activateTab(next);
    else setActiveId(null);
  }
}

/**
 * 新建会话:控制通道 SessionCreate → 轮询 sessions 找新 seed(≤6s)。
 *
 * `cwd` 取输入区的目标工作区(`newSessionCwd`);daemon 透传给 `session.new`,
 * 落 `SessionMeta.cwd` 并触发 workspace 自动归属(`grouping.rs:278` 只认已注册
 * 工作区,所以「选文件夹」那条路先在 `chooseNewSessionFolder` 里注册)。
 */
export async function createSession(): Promise<void> {
  if (creating()) return;
  setCreating(true);
  try {
    const before = new Set((await transport.sessions()).map((item) => String(item.session_id)));
    await transport.command("control", {
      channel: "control",
      type: "session_create",
      close_current: false,
      cwd: newSessionCwd(),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const list = await transport.sessions();
      setSessionCatalog(list as SidebarSession[]);
      const fresh = list.map((item) => String(item.session_id)).find((id) => !before.has(id));
      if (fresh != null) {
        await openSession(fresh);
        return;
      }
    }
    throw new Error("会话创建超时");
  } catch (error) {
    setBootError(String(error instanceof Error ? error.message : error));
  } finally {
    setCreating(false);
  }
}

/**
 * 注册目录为工作区(`workspace.create`)。后端按 canonical 路径查重,重复注册
 * 返回既有条目,所以「再选一次同一个文件夹」是幂等的。
 */
export async function registerWorkspace(path: string): Promise<SidebarWorkspace | null> {
  try {
    const created = await transport.rpc<SidebarWorkspace>("workspace.create", { path });
    await pollSessions();
    return created;
  } catch (error) {
    toast(`${STR.workspaceRegisterFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
    return null;
  }
}

/**
 * 原生选目录 → 注册 → 设为新建会话的目标。
 *
 * 取消(null)静默返回:浏览器预览没有原生对话框,固定回 null,不该在这里弹错。
 * 注册失败仍把选中路径设为目标——目录被删之类的注册失败,不该连「按这个目录
 * 开会话」一起否掉,那种会话只是落进「未分组」。
 */
export async function chooseNewSessionFolder(): Promise<void> {
  let picked: string | null = null;
  try {
    picked = await transport.pickDirectory();
  } catch (error) {
    toast(`${STR.workspacePickerFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
    return;
  }
  if (picked == null) return;
  const workspace = await registerWorkspace(picked);
  setNewSessionCwd(workspace?.path ?? picked);
}

/**
 * 把会话移入指定工作区(`workspace.move_session`):只改组织归属,不碰会话的
 * `SessionMeta.cwd`——运行目录归 `workspace.set`,是另一条路径。
 *
 * seed 由参数显式给(不靠宿主注入的活动会话):侧栏能对任意一条会话操作。
 */
export async function moveSessionToWorkspace(seed: string, workspaceId: string): Promise<void> {
  try {
    await transport.rpc("workspace.move_session", { session_id: seed, workspace_id: workspaceId });
    await pollSessions();
  } catch (error) {
    toast(`${STR.moveSessionFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
  }
}

/** 把会话移出工作区 → 未分组(`workspace.detach`)。 */
export async function detachSessionFromWorkspace(seed: string): Promise<void> {
  try {
    await transport.rpc("workspace.detach", { session_id: seed });
    await pollSessions();
  } catch (error) {
    toast(`${STR.detachSessionFailed}：${error instanceof Error ? error.message : String(error)}`, "err");
  }
}

/**
 * 轮询 sessions 列表:标题/turn_count 驱动后台状态点(§5.2)。
 *
 * in-flight 合并:15s 定时器、窗口聚焦、meta 频道事件会同时来敲,同一时刻只留
 * 一条 `session.list` 在飞,其余调用复用同一个 promise。
 */
let sessionsFlight: Promise<void> | null = null;

export function pollSessions(): Promise<void> {
  sessionsFlight ??= pullSessions().finally(() => { sessionsFlight = null; });
  return sessionsFlight;
}

async function pullSessions(): Promise<void> {
  try {
    const [list, workspaces] = await Promise.all([
      transport.sessions() as Promise<SidebarSession[]>,
      transport.rpc<SidebarWorkspace[]>("workspace.list").catch(() => []),
    ]);
    setSessionCatalog(list);
    setWorkspaceCatalog(workspaces);
    for (const item of list) {
      const tab = tabs().find((candidate) => candidate.seed === String(item.session_id));
      if (tab == null) continue;
      tab.store.applySessionMeta({
        title: typeof item.title === "string" ? item.title : null,
        turn_count: typeof item.turn_count === "number" ? item.turn_count : undefined,
      });
    }
  } catch {
    // 轮询失败静默,下一轮再取。
  }
}

/**
 * 会话被 daemon 判了终态(`MetaDelta::Deleted`):目录项立刻摘除,标签一并关掉。
 * 留着它只会让下一次点击变成「快照拉不到」的错误屏。
 */
async function dropSession(seed: string): Promise<void> {
  setSessionCatalog(sessionCatalog().filter((item) => String(item.session_id) !== seed));
  const tab = tabs().find((candidate) => candidate.seed === seed);
  if (tab != null) await closeTab(tab.id);
}

/** 启动:选一个非归档会话(优先运行中)作为第一个标签。 */
export async function boot(): Promise<void> {
  const [list, workspaces] = await Promise.all([
    transport.sessions() as Promise<SidebarSession[]>,
    transport.rpc<SidebarWorkspace[]>("workspace.list").catch(() => []),
  ]);
  setSessionCatalog(list);
  setWorkspaceCatalog(workspaces);
  const live = list.find((item) => !item.archived && item.busy) ?? list.find((item) => !item.archived) ?? list[0];
  if (live?.session_id == null) {
    setBootError(null);
    return;
  }
  await openSession(String(live.session_id));
}

