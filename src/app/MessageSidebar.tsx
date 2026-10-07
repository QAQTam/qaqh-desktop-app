import { createSignal, For, Show, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconFolder from "~icons/lucide/folder";
import IconMessageSquare from "~icons/lucide/message-square";
import { sessionCatalog, workspaceCatalog, type SidebarSession, type SidebarWorkspace } from "../tabs/store";

const pathName = (path: string | null | undefined): string => {
  const value = (path ?? "").replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名工作区";
};

const sessionName = (session: SidebarSession): string =>
  session.title?.trim() || session.last_summary?.trim() || `会话 ${session.session_id.slice(0, 8)}`;

export const MessageSidebar: Component<{
  onSelect: (seed: string) => void;
  sessions?: SidebarSession[];
  workspaces?: SidebarWorkspace[];
  activeSeed?: string | null;
}> = (props) => {
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
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
                    return (
                      <button
                        class={{ "message-session-item": true, active: active(), running: session.running === true }}
                        type="button"
                        aria-current={active() ? "page" : undefined}
                        onClick={() => props.onSelect(session.session_id)}
                        title={session.title || session.cwd || session.session_id}
                      >
                        <IconMessageSquare />
                        <span>{sessionName(session)}</span>
                        <Show when={session.running}><i class="message-session-running" aria-label="工作中" /></Show>
                      </button>
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
