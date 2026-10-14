import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  EFFORT_LADDER,
  MODEL_SPECS,
  modelContextWindow,
  modelDefaultEffort,
  modelEfforts,
  modelSpec,
} from "../src/models/specs";
import { DSACCOUNT_CONTEXT_LENGTH, isOauthMode, OAUTH_CONTEXT_LENGTH } from "../src/oauth/mode";
import {
  activeProviderId,
  captureProviderState,
  loadState,
  PROVIDER_STATE_KEY,
  rememberState,
  saveState,
  switchFields,
  type StorageLike,
} from "../src/oauth/provider-state";
import {
  BYOK_PROVIDER_ID,
  DSACCOUNT_PROVIDER_ID,
  PLAN_PROVIDER_ID,
  PROVIDERS,
  providerById,
  providerRegistryProblems,
} from "../src/oauth/providers";

function memStorage(initial?: string): StorageLike {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

/** 一个「BYOK 已经配好」的读模型快照。 */
const BYOK_CONFIG = {
  model: "deepseek-v4.1-flash",
  reasoningEffort: "high",
  baseUrl: "https://api.deepseek.com",
  wire: "openai",
  contextLength: 128_000,
};

describe("套餐模式判定", () => {
  it("只有 credential=chatgpt_plan 才算开启", () => {
    expect(isOauthMode({ credential: "chatgpt_plan" })).toBe(true);
    expect(isOauthMode({ credential: "api_key" })).toBe(false);
    // 读模型未加载 / 未知取值都按「没开」处理——置灰是破坏性呈现。
    expect(isOauthMode(null)).toBe(false);
    expect(isOauthMode(undefined)).toBe(false);
    expect(isOauthMode({ credential: "" })).toBe(false);
  });
});

describe("服务商名录", () => {
  it("自检无问题，且恰好一家 byok（关掉套餐才有地方可退）", () => {
    expect(PROVIDERS.length).toBeGreaterThan(1);
    expect(providerRegistryProblems()).toEqual([]);
    expect(PROVIDERS.filter((p) => p.kind === "byok")).toHaveLength(1);
  });

  it("自检能抓出重复 id / 空字段 / byok 家数不对", () => {
    const dup = [
      { id: "a", name: "A", blurb: "x", kind: "byok" as const },
      { id: "a", name: "B", blurb: "y", kind: "byok" as const },
    ];
    const problems = providerRegistryProblems(dup);
    expect(problems.some((p) => p.includes("id 重复"))).toBe(true);
    expect(problems.some((p) => p.includes("byok provider 应恰好一家"))).toBe(true);
    expect(providerById("nope")).toBeNull();
    expect(providerById(PLAN_PROVIDER_ID)?.kind).toBe("plan");
  });
});

describe("模型特判合集", () => {
  it("实测到的套餐 slug 都有条目（565K + 展示名）", () => {
    for (const slug of [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]) {
      const { spec, known } = modelSpec("plan", slug);
      expect(known, slug).toBe(true);
      expect(spec.displayName, slug).toBeTruthy();
      expect(modelContextWindow(spec), slug).toBe(565_000);
    }
  });

  it("未收录的模型不报错但必须标出 known=false，字段走保守缺省", () => {
    const { spec, known } = modelSpec("plan", "brand-new-model");
    expect(known).toBe(false);
    expect(modelContextWindow(spec)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(modelEfforts(spec)).toEqual(EFFORT_LADDER);
    expect(modelContextWindow(spec)).toBeLessThan(OAUTH_CONTEXT_LENGTH);
  });

  it("efforts 可以收窄档位；默认档不在可选里时落到最弱档", () => {
    expect(modelEfforts({ efforts: ["low", "high"] })).toEqual(["low", "high"]);
    expect(modelDefaultEffort({ efforts: ["low", "high"], defaultEffort: "ultra" })).toBe("low");
    expect(modelDefaultEffort({ defaultEffort: "xhigh" })).toBe("xhigh");
    // byok 桶空是有意的：说不出差异就别写。
    expect(MODEL_SPECS.byok).toEqual({});
  });

  it("档位按桶分开：套餐不含 max，DeepSeek 账号原样收平台的 max", () => {
    // 后端阶梯是六档（含 max）；Codex 那套只有五档，所以套餐桶显式排除它。
    expect(EFFORT_LADDER).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    for (const spec of Object.values(MODEL_SPECS.plan)) {
      expect(modelEfforts(spec)).not.toContain("max");
    }
    // 平台自报 `effort.supported_levels: ["low","high","max"]`——原样收，不用 ultra 顶替。
    for (const spec of Object.values(MODEL_SPECS.account)) {
      expect(modelEfforts(spec)).toEqual(["low", "high", "max"]);
    }
    // 未收录模型仍走全阶梯（BYOK 端点由用户自己声明，后端 allowlist 兜底钳制）。
    expect(modelEfforts({})).toEqual(EFFORT_LADDER);
  });
});

describe("每 provider 状态：切换与还原", () => {
  it("DeepSeek 账号的切换字段：openai wire + 端点自报的 1M 分母", () => {
    const entry = providerById(DSACCOUNT_PROVIDER_ID);
    expect(entry?.kind).toBe("account");
    if (entry == null) return;
    expect(switchFields(entry, {}, "https://api.deepseek.com")).toMatchObject({
      credential: "deepseek_account",
      wire: "openai",
      baseUrl: "https://api.deepseek.com",
      contextLength: DSACCOUNT_CONTEXT_LENGTH,
    });
    // 分母是"本地压缩何时发生"，用户自己调过就尊重他的值（每 provider 状态要还原回来）。
    expect(
      switchFields(entry, { [DSACCOUNT_PROVIDER_ID]: { contextLength: 128_000 } }, null),
    ).toMatchObject({ contextLength: 128_000 });
  });

  it("当前生效的是哪家：读配置里的 credential", () => {
    expect(activeProviderId({ credential: "chatgpt_plan" })).toBe(PLAN_PROVIDER_ID);
    expect(activeProviderId({ credential: "api_key" })).toBe(BYOK_PROVIDER_ID);
  });

  it("切到套餐：写 credential/wire/565K，端点用后端下发的官方值", () => {
    const plan = providerById(PLAN_PROVIDER_ID)!;
    const fields = switchFields(plan, {}, "https://api.openai.com/v1");
    expect(fields).toEqual({
      credential: "chatgpt_plan",
      wire: "responses",
      contextLength: OAUTH_CONTEXT_LENGTH,
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("拿不到官方端点时不猜 URL（只写 credential/wire/上下文）", () => {
    const plan = providerById(PLAN_PROVIDER_ID)!;
    expect(switchFields(plan, {}, null)).toEqual({
      credential: "chatgpt_plan",
      wire: "responses",
      contextLength: OAUTH_CONTEXT_LENGTH,
    });
  });

  /// 这条就是「关掉 OAuth 会丢配置」的回归：先抓 BYOK 那套，切到套餐，再切回来。
  it("切回自带 key 时把模型/端点/协议还原回去（不丢配置）", () => {
    const byok = providerById(BYOK_PROVIDER_ID)!;
    const plan = providerById(PLAN_PROVIDER_ID)!;

    // 1) 开套餐之前先抓一份，存进 byok 槽位。
    let states = rememberState({}, byok.id, captureProviderState(BYOK_CONFIG));
    // 2) 切到套餐。
    const toPlan = switchFields(plan, states, "https://api.openai.com/v1");
    expect(toPlan.credential).toBe("chatgpt_plan");
    // 3) 关套餐。
    const back = switchFields(byok, states, "https://api.openai.com/v1");
    expect(back).toEqual({
      credential: "api_key",
      model: "deepseek-v4.1-flash",
      baseUrl: "https://api.deepseek.com",
      wire: "openai",
    });
    // 没抓过的槽位不写空值（合并补丁的空串 = 保持现值，写空等于没写还更容易误读）。
    states = rememberState(states, plan.id, {});
    expect(switchFields(byok, states, null)).toEqual(back);
  });

  it("套餐槽位记住了模型时，切回套餐用它；没记住就不发 model（不覆盖用户选的）", () => {
    const plan = providerById(PLAN_PROVIDER_ID)!;
    const withModel = switchFields(plan, { [plan.id]: { model: "gpt-6-luna" } }, null);
    expect(withModel.model).toBe("gpt-6-luna");
    expect("model" in switchFields(plan, {}, null)).toBe(false);
  });

  it("存储往返：写得进读得出；坏数据/非对象一律退回空表", () => {
    const storage = memStorage();
    saveState({ [PLAN_PROVIDER_ID]: { model: "gpt-6-sol" } }, storage);
    expect(loadState(storage)).toEqual({ [PLAN_PROVIDER_ID]: { model: "gpt-6-sol" } });
    expect(storage.getItem(PROVIDER_STATE_KEY)).toContain("gpt-6-sol");

    expect(loadState(memStorage("{ not json"))).toEqual({});
    expect(loadState(memStorage("[1,2,3]"))).toEqual({});
    expect(loadState(memStorage('{"openai": 42}'))).toEqual({});
    // 没有存储（隐私模式/SSR）也不炸。
    expect(loadState(null)).toEqual({});
    expect(() => saveState({}, null)).not.toThrow();
  });
});
