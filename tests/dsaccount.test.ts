/**
 * DeepSeek 账号：金额格式化 + 视图推导 + 登录流程驱动。
 *
 * 这三块都是纯函数（`src/dsaccount/{state,flow}.ts` 刻意不碰壳 API），所以测试
 * 直接跑真实现——没有 mock 壳命令，测的就是生产路径。
 */
import { describe, expect, it, vi } from "vitest";

import {
  dsAccountView,
  dsFlowRunning,
  formatAmount,
  isPositive,
  type DsAccountStatus,
} from "../src/dsaccount/state";
import { runDeepSeekSignIn, type DsSignInDeps } from "../src/dsaccount/flow";
import { modelContextWindow, modelEfforts, modelSpec } from "../src/models/specs";

const status = (over: Partial<DsAccountStatus> = {}): DsAccountStatus => ({
  signedIn: false,
  account: null,
  storageError: null,
  inferenceOrigin: "https://api.deepseek.com",
  usageUrl: "https://platform.deepseek.com/usage",
  topUpUrl: "https://platform.deepseek.com/top_up",
  flow: { attemptId: null, state: "idle", authorizeUrl: null, expiresAtMs: 0, error: null },
  ...over,
});

const signedIn = (label = "测试用户"): DsAccountStatus =>
  status({
    signedIn: true,
    account: {
      user_id: "user-1",
      label,
      provider: "WECHAT",
      currency: "CNY",
      inference_origin: "https://api.deepseek.com",
      saved_at_ms: 1,
      has_credential: true,
    },
  });

describe("金额格式化（后端给的是 big.js 原串）", () => {
  it("按展示口径给两位小数，但绝不把解析失败编成 0", () => {
    expect(formatAmount("0E-16")).toBe("0.00");
    expect(formatAmount("0")).toBe("0.00");
    expect(formatAmount("12.3400000000000000")).toBe("12.34");
    expect(formatAmount("1e+3")).toBe("1000.00");
    // 看不懂的写法原样显示：宁可显示一个怪串，也不假装是 0。
    expect(formatAmount("???")).toBe("???");
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount("  ")).toBe("—");
  });

  it("isPositive 对「不知道」返回 null，而不是 false", () => {
    expect(isPositive("0E-16")).toBe(false);
    expect(isPositive("10.00")).toBe(true);
    expect(isPositive("???")).toBeNull();
    expect(isPositive(null)).toBeNull();
  });
});

describe("账号视图推导", () => {
  it("还没读到状态时是 loading（不给一个会误导人的空态）", () => {
    const view = dsAccountView(null);
    expect(view.kind).toBe("loading");
    expect(view.canSignIn).toBe(false);
  });

  it("未登录 → 可以登录", () => {
    const view = dsAccountView(status());
    expect(view.kind).toBe("signed-out");
    expect(view.canSignIn).toBe(true);
    expect(view.canSignOut).toBe(false);
  });

  it("进行中（authorizing/exchanging）→ 可以取消，不能重复登录", () => {
    for (const state of ["authorizing", "exchanging"] as const) {
      const view = dsAccountView(
        status({ flow: { attemptId: "a1", state, authorizeUrl: "https://x", expiresAtMs: 1, error: null } }),
      );
      expect(view.kind).toBe("connecting");
      expect(view.canCancel).toBe(true);
      expect(view.canSignIn).toBe(false);
      expect(dsFlowRunning(state)).toBe(true);
    }
  });

  it("已登录 → 昵称优先，退回到账号 ID 前缀", () => {
    expect(dsAccountView(signedIn()).title).toBe("测试用户");
    const anonymous = signedIn("");
    expect(dsAccountView(anonymous).title).toBe("DeepSeek 账号 user-1");
    expect(dsAccountView(signedIn()).canSignOut).toBe(true);
  });

  it("本地凭据损坏**不等于**未登录：要提示重新登录", () => {
    const view = dsAccountView(status({ storageError: "凭据解密失败（本地凭据已损坏）" }));
    expect(view.kind).toBe("damaged");
    expect(view.canSignIn).toBe(true);
    expect(view.error).toContain("损坏");
  });

  it("已登录时，一次失败的**新**登录只作为提示带出来", () => {
    const view = dsAccountView(
      signedIn(),
    );
    expect(view.error).toBeNull();

    const withFailure = dsAccountView({
      ...signedIn(),
      flow: {
        attemptId: "a1",
        state: "failed",
        authorizeUrl: null,
        expiresAtMs: 0,
        error: "用户在浏览器中拒绝了授权",
      },
    });
    expect(withFailure.kind).toBe("signed-in");
    expect(withFailure.error).toBe("用户在浏览器中拒绝了授权");
    expect(withFailure.canSignOut).toBe(true);
  });

  it("未登录 + 上次失败 → 把失败原因显示出来", () => {
    const view = dsAccountView(
      status({
        flow: { attemptId: "a1", state: "failed", authorizeUrl: null, expiresAtMs: 0, error: "登录超时" },
      }),
    );
    expect(view.kind).toBe("signed-out");
    expect(view.error).toBe("登录超时");
  });
});

/** 可控时钟 + 假依赖。 */
function fakeDeps(overrides: Partial<DsSignInDeps> = {}): {
  deps: DsSignInDeps;
  advance(ms: number): void;
  opened: string[];
  cancelled: string[];
} {
  let clock = 1_000;
  const opened: string[] = [];
  const cancelled: string[] = [];
  const deps: DsSignInDeps = {
    start: async () => ({
      attemptId: "attempt-1",
      authorizeUrl: "https://platform.deepseek.com/dsh/authorize?authorize_id=x",
      redirectUri: "http://127.0.0.1:51337/oauth/callback",
      expiresIn: 600,
    }),
    status: async () => ({ attemptId: "attempt-1", state: "authorizing", error: null }),
    cancel: async (attemptId) => {
      cancelled.push(attemptId);
      return null;
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    now: () => clock,
    sleep: async () => undefined,
    ...overrides,
  };
  return { deps, advance: (ms) => (clock += ms), opened, cancelled };
}

describe("登录流程驱动", () => {
  it("开工 → 开系统浏览器 → 轮询到 signed-in", async () => {
    let calls = 0;
    const { deps, opened } = fakeDeps({
      status: async () => {
        calls += 1;
        return calls < 3
          ? { attemptId: "attempt-1", state: "authorizing", error: null }
          : { attemptId: "attempt-1", state: "signed-in", error: null };
      },
    });
    const onStarted = vi.fn();
    const outcome = await runDeepSeekSignIn({ pollMs: 0, onStarted }, deps);
    expect(outcome).toEqual({ kind: "completed" });
    expect(onStarted).toHaveBeenCalledWith("attempt-1");
    expect(opened).toEqual(["https://platform.deepseek.com/dsh/authorize?authorize_id=x"]);
    expect(calls).toBe(3);
  });

  it("被新一次登录顶掉 → superseded（不是失败）", async () => {
    const { deps } = fakeDeps({
      status: async () => ({ attemptId: "attempt-2", state: "authorizing", error: null }),
    });
    expect(await runDeepSeekSignIn({ pollMs: 0 }, deps)).toEqual({ kind: "superseded" });
  });

  it("失败与取消都带出原因", async () => {
    const failed = fakeDeps({
      status: async () => ({ attemptId: "attempt-1", state: "failed", error: "invalid authorization" }),
    });
    expect(await runDeepSeekSignIn({ pollMs: 0 }, failed.deps)).toEqual({
      kind: "failed",
      code: "failed",
      message: "invalid authorization",
    });

    const cancelled = fakeDeps({
      status: async () => ({ attemptId: "attempt-1", state: "cancelled", error: "用户在浏览器中拒绝了授权" }),
    });
    const outcome = await runDeepSeekSignIn({ pollMs: 0 }, cancelled.deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "cancelled" });
  });

  it("超时：**先取消**再报失败（留一个进行中的尝试会顶掉下一次登录）", async () => {
    const { deps, advance, cancelled } = fakeDeps();
    const original = deps.sleep;
    deps.sleep = async (ms) => {
      advance(10 * 60 * 1000);
      await original(ms);
    };
    const outcome = await runDeepSeekSignIn({ pollMs: 1 }, deps);
    expect(outcome).toMatchObject({ kind: "failed", code: "expired" });
    expect(cancelled).toEqual(["attempt-1"]);
  });

  it("取消本身失败也要能返回结论（不能把 UI 挂在超时上）", async () => {
    const { deps, advance } = fakeDeps({
      cancel: async () => {
        throw new Error("connection busy");
      },
    });
    const original = deps.sleep;
    deps.sleep = async (ms) => {
      advance(10 * 60 * 1000);
      await original(ms);
    };
    expect(await runDeepSeekSignIn({ pollMs: 1 }, deps)).toMatchObject({ code: "expired" });
  });
});

describe("DeepSeek 账号的模型特判", () => {
  it("两个实测模型都收录，档位只给平台认的 low/high", () => {
    const flash = modelSpec("account", "deepseek-flash");
    expect(flash.known).toBe(true);
    // 平台声明的是 low|high|max，而我们的阶梯里没有 max：宁可少一档，
    // 也不发一个它不认的档（那会以 400 打在推理端点上）。
    expect(modelEfforts(flash.spec)).toEqual(["low", "high"]);
    expect(modelContextWindow(flash.spec)).toBe(1_000_000);
    expect(modelSpec("account", "deepseek-v4-pro").known).toBe(true);
  });

  it("未收录的模型走保守缺省：窗口不许猜大", () => {
    const unknown = modelSpec("account", "deepseek-next");
    expect(unknown.known).toBe(false);
    expect(modelContextWindow(unknown.spec)).toBe(128_000);
  });

  it("桶是分开的：两家的 slug 互不串门", () => {
    expect(modelSpec("account", "gpt-6-sol").known).toBe(false);
    expect(modelSpec("plan", "deepseek-flash").known).toBe(false);
  });
});
