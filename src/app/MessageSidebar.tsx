import { createSignal, For, Show, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconFolder from "~icons/lucide/folder";
import IconMessageSquare from "~icons/lucide/message-square";
import IconMoreHorizontal from "~icons/lucide/more-horizontal";
import IconPlus from "~icons/lucide/plus";
import { STR } from "../lib/strings";
import { sessionCatalog, workspaceCatalog, type SidebarSession, type SidebarWorkspace } from "../tabs/store";

const pathName = (path: string | null | undefined): string => {
  const value = (path ?? "").replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名工作区";
};

const sessionName = (session: SidebarSession): string =>
  session.title?.trim() || `会话 ${session.session_id.slice(0, 8)}`;

export const MessageSidebar: Component<{
  onSelect: (seed: string) => void;
  sessions?: SidebarSession[];
  workspaces?: SidebarWorkspace[];
  activeSeed?: string | null;
  onCreate?: () => void;
  creating?: boolean;
  canCreate?: boolean;
  /** 移入工作区(`workspace.move_session`);只改组织归属,不动会话运行目录。 */
  onMove?: (seed: string, workspaceId: string) => void;
  /** 移出到未分组(`workspace.detach`)。 */
  onDetach?: (seed: string) => void;
}> = (props) => {
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  /** 展开行菜单的会话 seed(null = 全部收起);同时只开一个。 */
  const [menuSeed, setMenuSeed] = createSignal<string | null>(null);
  const allSessions = () => props.sessions ?? sessionCatalog();
  const allWorkspaces = () => props.workspaces ?? workspaceCatalog();
  const groups = () => {
    const workspaces = allWorkspaces();
    const sessions = allSessions().filter((item) => !item.archived);
    const grouped = workspaces.map((workspace) => ({
      id: workspace.id,
      title: workspace.title || pathName(workspace.path),
      path: workspace.path,
      sessions: sessions.filter((session) => session.workspace_id === workspace.id),
    }));
    const ungrouped = sessions.filter((session) => !session.workspace_id || !workspaces.some((workspace) => workspace.id === session.workspace_id));
    if (ungrouped.length > 0) grouped.push({ id: "__ungrouped", title: "未分组", path: "", sessions: ungrouped });
    return grouped.filter((group) => group.sessions.length > 0);
  };
  const toggle = (id: string): void => {
    const next = new Set(collapsed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  return (
    <aside class="message-sidebar" aria-label="工作区与会话">
      <div class="message-sidebar-head">
        <span>工作区</span>
        <span class="message-sidebar-count">{allSessions().filter((item) => !item.archived).length}</span>
        <Show when={props.onCreate != null}>
          <button type="button" class="message-create" aria-label="新建会话" title="新建会话" disabled={props.creating || props.canCreate === false} onClick={() => props.onCreate?.()}><IconPlus /></button>
        </Show>
      </div>
      <div class="message-sidebar-groups">
        <Show when={groups().length > 0} fallback={<div class="message-sidebar-empty">暂无会话</div>}>
          <For each={groups()}>{(group) => (
            <section class="message-workspace-group">
              <button
                class="message-workspace-toggle"
                type="button"
                aria-expanded={collapsed().has(group.id) ? "false" : "true"}
                onClick={() => toggle(group.id)}
                title={group.path || group.title}
              >
                <IconChevronDown class={{ collapsed: collapsed().has(group.id) }} />
                <Show when={group.id !== "__ungrouped"}><IconFolder /></Show>
                <span class="message-workspace-title">{group.title}</span>
                <span class="message-workspace-count">{group.sessions.length}</span>
              </button>
              <Show when={!collapsed().has(group.id)}>
                <div class="message-workspace-sessions">
                  <For each={[...group.sessions].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))}>{(session) => {
                    const active = () => props.activeSeed === session.session_id;
                    const menuOpen = () => menuSeed() === session.session_id;
                    // 归属看「名录里真有这个工作区」,而不是 workspace_id 非空:
                    // 工作区被删后 id 仍留在卡片上,那种会话显示在未分组里,
                    // 再给它「移出」就成了无意义动作。
                    const grouped = () => allWorkspaces().some((workspace) => workspace.id === session.workspace_id);
                    return (
                      <>
                        <div class={{ "message-session-row": true, active: active() }}>
                          <button
                            class={{ "message-session-item": true, active: active(), running: session.busy === true }}
                            type="button"
                            aria-current={active() ? "page" : undefined}
                            onClick={() => props.onSelect(session.session_id)}
                            title={session.title || session.cwd || session.session_id}
                          >
                            <IconMessageSquare />
                            <span>{sessionName(session)}</span>
                            <Show when={session.busy}><i class="message-session-running" aria-label="工作中" /></Show>
                          </button>
                          <Show when={props.onMove != null && allWorkspaces().length > 0}>
                            <button
                              type="button"
                              class="message-session-more"
                              aria-label={`${STR.sessionActions}:${sessionName(session)}`}
                              aria-expanded={menuOpen() ? "true" : "false"}
                              title={STR.sessionActions}
                              onClick={() => setMenuSeed(menuOpen() ? null : session.session_id)}
                            >
                              <IconMoreHorizontal />
                            </button>
                          </Show>
                        </div>
                        <Show when={menuOpen()}>
                          <div class="message-session-menu" role="menu">
                            <strong>{STR.moveToWorkspace}</strong>
                            <For each={allWorkspaces()}>{(workspace) => (
                              <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={session.workspace_id === workspace.id ? "true" : "false"}
                                class={session.workspace_id === workspace.id ? "selected" : undefined}
                                onClick={() => { setMenuSeed(null); props.onMove?.(session.session_id, workspace.id); }}
                              >
                                <span>{workspace.title || pathName(workspace.path)}</span>
                                <small class="message-session-menu-path">{workspace.path}</small>
                              </button>
                            )}</For>
                            <Show when={grouped()}>
                              <button
                                type="button"
                                role="menuitem"
                                class="message-session-menu-detach"
                                onClick={() => { setMenuSeed(null); props.onDetach?.(session.session_id); }}
                              >
                                <span>{STR.detachWorkspace}</span>
                              </button>
                            </Show>
                          </div>
                        </Show>
                      </>
                    );
                  }}</For>
                </div>
              </Show>
            </section>
          )}</For>
        </Show>
      </div>
    </aside>
  );
};
