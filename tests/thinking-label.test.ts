/**
 * 思考标签:套餐摘要 vs 模型原文必须分开(见 src/turn/thinking-label.ts)。
 * 后端 `reasoning_kind` 缺席时不许猜成摘要——那是把"没标注"说成"是摘要"。
 */
import { describe, expect, test } from "vitest";
import { STR } from "../src/lib/strings";
import { thinkingLabel, thinkingTitle } from "../src/turn/thinking-label";

describe("thinkingLabel", () => {
  test("summary 走「思考摘要」,并带上解释", () => {
    expect(thinkingLabel("summary")).toBe(STR.thinkingSummary);
    expect(thinkingLabel("summary")).toBe("思考摘要");
    expect(thinkingTitle("summary")).toBe(STR.thinkingSummaryTitle);
  });

  test("text / encrypted / redacted / 缺失 都按「思考」显示,且不挂空 title", () => {
    expect(thinkingLabel("text")).toBe(STR.thinking);
    expect(thinkingLabel("encrypted")).toBe(STR.thinking);
    expect(thinkingLabel("redacted")).toBe(STR.thinking);
    expect(thinkingLabel(undefined)).toBe(STR.thinking);
    expect(thinkingLabel(null)).toBe(STR.thinking);
    for (const kind of ["text", "encrypted", "redacted", undefined, null] as const) {
      expect(thinkingTitle(kind)).toBeUndefined();
    }
  });
});
