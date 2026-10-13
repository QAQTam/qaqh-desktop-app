import { describe, expect, it } from "vitest";
import { pendingPresentation, runStatusOf, workingOnly } from "../src/app/session-pending";
import type { SessionRunStatus } from "../src/api/qaqh/SessionRunStatus";

const at = (status: SessionRunStatus | undefined, busy?: boolean) =>
  pendingPresentation({ title: "排查上下文压缩", status, busy });

describe("侧栏待响应映射", () => {
  it("三态待人响应,各自文案与语义色", () => {
    expect(at("waiting_permission")).toMatchObject({ kind: "permission", label: "请求授权", phase: "pending" });
    expect(at("waiting_ask")).toMatchObject({ kind: "ask", label: "请求回答", phase: "pending" });
    expect(at("waiting_plan")).toMatchObject({ kind: "plan", label: "计划评审", phase: "pending" });
  });

  it("在跑与空闲不弹卡:待响应是「球在用户这边」,不是「还挂着事」", () => {
    // 与宿主 `session_is_busy` 的差别就在这里——那边 `working` 也算挂着事。
    for (const status of ["working", "idle", "not_running", "canceled", "error"] as SessionRunStatus[]) {
      expect(at(status), status).toBeNull();
    }
  });

  it("canceled / error 是上一回合终态驻留,不得渲染成待办", () => {
    expect(at("canceled")?.kind).toBeUndefined();
    expect(at("error")?.kind).toBeUndefined();
  });

  it("标题缺省时无障碍名退回通用主语,不留空 label", () => {
    const view = pendingPresentation({ title: null, status: "waiting_ask" });
    expect(view?.ariaLabel).toBe("该会话:请求回答");
    expect(pendingPresentation({ title: "   ", status: "waiting_ask" })?.ariaLabel).toBe("该会话:请求回答");
  });

  it("旧 daemon 只有 running/busy 时降级:true 当在跑,false/缺省当空闲", () => {
    expect(runStatusOf({ status: undefined, busy: true })).toBe("working");
    expect(runStatusOf({ status: undefined, busy: false })).toBe("idle");
    expect(runStatusOf({ status: undefined })).toBe("idle");
    // 降级路径下不可能得出「等人」——这正是要补 status 投影的理由。
    expect(at(undefined, true)).toBeNull();
    expect(at(undefined, false)).toBeNull();
  });

  it("status 存在时优先于 busy,不被兼容字段带偏", () => {
    expect(runStatusOf({ status: "idle", busy: true })).toBe("idle");
    expect(at("waiting_permission", false)).toMatchObject({ kind: "permission" });
  });

  it("working 仍是唯一点亮旧状态点的状态", () => {
    expect(workingOnly({ status: "working" })).toBe(true);
    expect(workingOnly({ status: "waiting_ask" })).toBe(false);
    expect(workingOnly({ status: undefined, busy: true })).toBe(true);
  });
});