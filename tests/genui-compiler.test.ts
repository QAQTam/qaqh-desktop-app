import { describe, expect, it } from "vitest";
import { compileSurface, GenUiError, type SurfaceIR } from "../src/genui/compiler";
import { evaluate } from "../src/genui/runtime/eval";

const COUNTER = [
  'ui.surface("counter", { root: "card", fallback: "计数器，初始值为 0。" });',
  'const count = ui.state("count", "integer", 0);',
  'ui.node("card", <Card title="计数器" children={["value", "increment", "reset"]} />);',
  'ui.node("value", <Metric label="当前计数" value={count} />);',
  'ui.node("increment", <Button label="增加" onPress={ui.set("count", count + 1)} />);',
  'ui.node("reset", <Button label="重置" onPress={ui.reset()} />);',
  "ui.end();",
].join("\n");

const compile = (source: string): SurfaceIR => compileSurface(source);
const fails = (source: string, message: string): void => {
  try {
    compile(source);
  } catch (cause) {
    expect(cause).toBeInstanceOf(GenUiError);
    expect((cause as GenUiError).message).toContain(message);
    return;
  }
  throw new Error(`应当编译失败:${message}`);
};

describe("genui DSL 编译器", () => {
  it("计数器配方 → 校验通过的 IR", () => {
    const ir = compile(COUNTER);
    expect(ir.irVersion).toBe("0.1");
    expect(ir.surfaceId).toBe("counter");
    expect(ir.fallback).toBe("计数器，初始值为 0。");
    expect(ir.rootId).toBe("card");
    expect(ir.states.count).toEqual({ type: "integer", initial: 0 });
    expect(ir.order).toEqual(["card", "value", "increment", "reset"]);
    expect(ir.nodes.card!.props.children).toEqual({ kind: "list", items: ["value", "increment", "reset"] });
    const onPress = ir.nodes.increment!.props.onPress;
    expect(onPress).toEqual({
      kind: "action",
      action: { kind: "set", key: "count", value: { op: "add", left: { op: "state", key: "count" }, right: { op: "lit", value: 1 } } },
    });
    expect(ir.nodes.reset!.props.onPress).toEqual({ kind: "action", action: { kind: "reset" } });
  });

  it("前向 children 引用合法;注释与空白被忽略", () => {
    const ir = compile([
      'ui.surface("s");',
      "ui.node(\"a\", <Stack children={[]} />); // 注释",
      "ui.node(\"b\", <Text text=\"你好\" />);",
      "ui.end();",
    ].join("\n"));
    expect(ir.order).toEqual(["a", "b"]);
  });

  it("结构裁决:surface 必须第一句 / end 必须最后 / 缺 end 拒绝", () => {
    fails('ui.node("a", <Text text="x" />);\nui.surface("s");\nui.end();', "第一条语句必须是 ui.surface");
    fails('ui.surface("s");\nui.end();\nui.node("a", <Text text="x" />);', "ui.end() 之后不允许再有语句");
    fails('ui.surface("s");\nui.node("a", <Text text="x" />);', "缺少 ui.end()");
  });

  it("拒绝未知语句、独立 ui.set、重复节点 id", () => {
    fails('ui.surface("s");\nimport "fs";\nui.end();', "无法识别的语句");
    fails('ui.surface("s");\nui.set("a", 1);\nui.end();', "只能作为事件值");
    fails('ui.surface("s");\nui.node("a", <Text text="x" />);\nui.node("a", <Text text="y" />);\nui.end();', "重复的节点 id");
  });

  it("拒绝未知组件、未知属性、未知状态引用", () => {
    fails('ui.surface("s");\nui.node("a", <Widget text="x" />);\nui.end();', "未知组件类型");
    fails('ui.surface("s");\nui.node("a", <Text nonsense="x" />);\nui.end();', "不支持属性 nonsense");
    fails('ui.surface("s");\nui.node("a", <Text text={missing} />);\nui.end();', "表达式引用未知状态");
    fails('ui.surface("s");\nui.node("a", <Button label="go" onPress={ui.set("nope", 1)} />);\nui.end();', "动作引用未知状态");
  });

  it("拒绝 children 环与未知 children 引用", () => {
    fails([
      'ui.surface("s");',
      'ui.node("a", <Stack children={["b"]} />);',
      'ui.node("b", <Stack children={["a"]} />);',
      "ui.end();",
    ].join("\n"), "children 形成环");
    fails([
      'ui.surface("s");',
      'ui.node("a", <Stack children={["ghost"]} />);',
      "ui.end();",
    ].join("\n"), "引用未知节点 ghost");
  });

  it("拒绝不安全初始值与类型不匹配", () => {
    fails('ui.surface("s");\nconst n = ui.state("n", "integer", 1.5);\nui.end();', "integer 初始值必须是安全整数");
    fails('ui.surface("s");\nconst b = ui.state("b", "boolean", 1);\nui.end();', "boolean 初始值");
    fails('ui.surface("s");\nconst s = ui.state("s", "widget", "x");\nui.end();', "不支持的状态类型");
  });

  it("表达式求值:四则、状态读取、类型与除零/溢出防护", () => {
    const states = { count: 2, flag: true, name: "x" };
    expect(evaluate({ op: "lit", value: 3 }, states)).toBe(3);
    expect(evaluate({ op: "state", key: "count" }, states)).toBe(2);
    expect(evaluate({ op: "add", left: { op: "state", key: "count" }, right: { op: "lit", value: 5 } }, states)).toBe(7);
    expect(evaluate({ op: "mul", left: { op: "state", key: "count" }, right: { op: "lit", value: 3 } }, states)).toBe(6);
    // add 遇字符串降级为拼接(布尔/数组经 display 收敛);纯数字才是算术。
    expect(evaluate({ op: "add", left: { op: "state", key: "name" }, right: { op: "lit", value: 1 } }, states)).toBe("x1");
    expect(evaluate({ op: "add", left: { op: "lit", value: "flag=" }, right: { op: "state", key: "flag" } }, states)).toBe("flag=是");
    expect(() => evaluate({ op: "sub", left: { op: "state", key: "name" }, right: { op: "lit", value: 1 } }, states)).toThrow(GenUiError);
    expect(() => evaluate({ op: "div", left: { op: "lit", value: 1 }, right: { op: "lit", value: 0 } }, states)).toThrow(/除零/);
  });

  it("比较与逻辑运算:and/or 短路、not、eq/gt 类型防护", () => {
    const states = { count: 2, flag: true, name: "x" };
    expect(evaluate({ op: "eq", left: { op: "state", key: "count" }, right: { op: "lit", value: 2 } }, states)).toBe(true);
    expect(evaluate({ op: "neq", left: { op: "state", key: "name" }, right: { op: "lit", value: "" } }, states)).toBe(true);
    expect(evaluate({ op: "gt", left: { op: "state", key: "count" }, right: { op: "lit", value: 1 } }, states)).toBe(true);
    expect(evaluate({ op: "and", left: { op: "state", key: "flag" }, right: { op: "lit", value: "t" } }, states)).toBe(true);
    // 短路:右边除零不求值。
    expect(evaluate({ op: "or", left: { op: "lit", value: true }, right: { op: "div", left: { op: "lit", value: 1 }, right: { op: "lit", value: 0 } } }, states)).toBe(true);
    expect(evaluate({ op: "not", value: { op: "state", key: "flag" } }, states)).toBe(false);
    expect(() => evaluate({ op: "gt", left: { op: "state", key: "name" }, right: { op: "lit", value: 1 } }, states)).toThrow(/大小比较/);
  });

  it("循环变量:item 只在同名作用域可见", () => {
    const scope = { as: "item", value: "hello" };
    expect(evaluate({ op: "item", as: "item" }, {}, scope)).toBe("hello");
    expect(() => evaluate({ op: "item", as: "item" }, {})).toThrow(/作用域/);
    expect(() => evaluate({ op: "item", as: "row" }, {}, scope)).toThrow(/作用域/);
  });

  it("表达式优先级:先乘除后加减,括号重进级联", () => {
    const ir = compile([
      'ui.surface("s");',
      'ui.node("m", <Metric label="x" value={1 + 2 * 3} />);',
      'ui.node("b", <Badge text={(1 + 2) * 3} />);',
      "ui.end();",
    ].join("\n"));
    expect(evaluate((ir.nodes.m!.props.value as { kind: "expr"; expr: never }).expr, {})).toBe(7);
    expect(evaluate((ir.nodes.b!.props.text as { kind: "expr"; expr: never }).expr, {})).toBe(9);
  });

  it("ui.derive 按声明顺序内联(编译期展开,天然无环)", () => {
    const ir = compile([
      'ui.surface("s");',
      'const name = ui.state("name", "string", "");',
      'const agree = ui.state("agree", "boolean", false);',
      'const filled = ui.derive(name != "");',
      'const ready = ui.derive(filled && agree);',
      'ui.node("b", <Button label="提交" disabled={!ready} onPress={ui.followUp("ok")} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.nodes.b!.props.disabled).toEqual({
      kind: "expr",
      expr: { op: "not", value: { op: "and", left: { op: "neq", left: { op: "state", key: "name" }, right: { op: "lit", value: "" } }, right: { op: "state", key: "agree" } } },
    });
    fails('ui.surface("s");\nui.followUp("p");\nui.node("b", <Button label="x" onPress={ui.followUp("p")} />);\nui.end();', "动作只能作为事件值");
  });

  it("for/repeat:模板节点、item 拼接、结构校验", () => {
    const ir = compile([
      'ui.surface("s");',
      'const tags = ui.state("tags", "list", ["a"]);',
      'ui.node("rows", <Text text={"· " + item} repeat={ui.for("tags", "item")} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.nodes.rows!.repeat).toEqual({ source: "tags", as: "item" });
    expect(ir.nodes.rows!.props.text).toEqual({
      kind: "expr",
      expr: { op: "add", left: { op: "lit", value: "· " }, right: { op: "item", as: "item" } },
    });
    fails([
      'ui.surface("s");',
      'const tags = ui.state("tags", "list", []);',
      'ui.node("rows", <Text text="x" repeat={ui.for("tags", "tags")} />);',
      "ui.end();",
    ].join("\n"), "重复的状态声明");
    fails([
      'ui.surface("s");',
      'const name = ui.state("name", "string", "");',
      'ui.node("rows", <Text text="x" repeat={ui.for("name", "item")} />);',
      "ui.end();",
    ].join("\n"), "repeat 需要 list 型状态");
  });

  it("多语句表达式与字符串属性转义", () => {
    const ir = compile([
      'ui.surface("s");',
      'const price = ui.state("price", "number", 2.5);',
      'const total = ui.state("total", "number", 0);',
      'ui.node("a", <Metric label="合计" value={total + price * 2} />);',
      'ui.node("b", <Text text="换\\n行\\"引号" />);',
      "ui.end();",
    ].join("\n"));
    const value = ir.nodes.a!.props.value;
    expect(value?.kind).toBe("expr");
    expect(evaluate((value as { kind: "expr"; expr: never }).expr, { price: 2.5, total: 1 })).toBe(6);
    expect((ir.nodes.b!.props.text as { kind: "lit"; value: string }).value).toBe("换\n行\"引号");
  });
});

describe("genui DSL 扩展(括号 / show / binding / jsonl)", () => {
  it("括号复合表达式按数学优先级降低到 IR", () => {
    const ir = compile([
      'ui.surface("s");',
      'const count = ui.state("count", "integer", 2);',
      'ui.node("m", <Metric label="x" value={(count + 1) * 2} />);',
      "ui.end();",
    ].join("\n"));
    const expr = (ir.nodes.m!.props.value as { kind: "expr"; expr: never }).expr;
    expect(evaluate(expr, { count: 2 })).toBe(6);
  });

  it("show 是所有组件可用的条件渲染属性", () => {
    const ir = compile([
      'ui.surface("s");',
      'const dark = ui.state("dark", "boolean", false);',
      'ui.node("b", <Badge text="x" show={dark} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.nodes.b!.props.show).toEqual({ kind: "expr", expr: { op: "state", key: "dark" } });
  });

  it("todo v2:TodoList/Todo 编译与 done 绑定校验", () => {
    const ir = compile([
      'ui.surface("plan", { root: "card" });',
      'const t1 = ui.state("t1", "boolean", false);',
      'ui.node("card", <TodoList title="计划" children={["i1"]} />);',
      'ui.node("i1", <Todo text="分帧器" done={ui.bind("t1")} meta="阶段 1" />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.nodes.card!.type).toBe("TodoList");
    expect(ir.nodes.i1!.props.done).toEqual({ kind: "binding", key: "t1" });
    fails([
      'ui.surface("s");',
      'const n = ui.state("n", "integer", 0);',
      'ui.node("i", <Todo text="x" done={ui.bind("n")} />);',
      "ui.end();",
    ].join("\n"), "需要 boolean 型状态");
  });

  it("ask v2:ui.followUp 编译为字段选择动作,未知字段拒绝", () => {
    const ir = compile([
      'ui.surface("s");',
      'const note = ui.state("note", "string", "");',
      'ui.node("b", <Button label="提交" onPress={ui.followUp("请继续", { "说明": note })} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.nodes.b!.props.onPress).toEqual({
      kind: "action",
      action: { kind: "followUp", prompt: "请继续", fields: [{ label: "说明", key: "note" }] },
    });
    // 字段值也可以直接写状态 key 字符串(与 jsonl wire 一致,两种写法等价)。
    const ir2 = compile([
      'ui.surface("s");',
      'const note = ui.state("note", "string", "");',
      'ui.node("b", <Button label="提交" onPress={ui.followUp("请继续", { "说明": "note" })} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir2.nodes.b!.props.onPress).toEqual({
      kind: "action",
      action: { kind: "followUp", prompt: "请继续", fields: [{ label: "说明", key: "note" }] },
    });
    fails('ui.surface("s");\nui.node("b", <Button label="x" onPress={ui.followUp("p", { "说明": ghost })} />);\nui.end();', "引用未知状态");
    fails('ui.surface("s");\nui.node("b", <Button label="x" onPress={ui.followUp("p", { "说明": "ghost" })} />);\nui.end();', "引用未知状态");
  });

  it("真实模型输出回归:报名表单(引号 key followUp + 表单组件全家族)", () => {
    const ir = compile([
      'ui.surface("signup-form", { title: "报名表单" });',
      'const name = ui.state("name", "string", "");',
      'const email = ui.state("email", "string", "");',
      'const company = ui.state("company", "string", "");',
      'const agree = ui.state("agree", "boolean", false);',
      'ui.node("card", <Card title="会议报名" children={["form"]} />);',
      'ui.node("form", <Stack children={["f_name","f_email","f_company","f_agree","sep","actions"]} />);',
      'ui.node("f_name", <TextInput label="姓名" value={name} placeholder="请输入姓名" />);',
      'ui.node("f_email", <TextInput label="邮箱" value={email} placeholder="you@example.com" />);',
      'ui.node("f_company", <TextInput label="公司 / 团队" value={company} placeholder="选填" />);',
      'ui.node("f_agree", <Checkbox label="我已阅读并同意活动条款" checked={agree} />);',
      'ui.node("sep", <Divider />);',
      'ui.node("actions", <Row children={["btn_submit","btn_reset"]} />);',
      'ui.node("btn_submit", <Button label="提交报名" onPress={ui.followUp("请处理我的报名信息：", { "姓名": "name", "邮箱": "email", "公司/团队": "company" })} />);',
      'ui.node("btn_reset", <Button label="重置" onPress={ui.reset()} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.surfaceId).toBe("signup-form");
    expect(ir.nodes.btn_submit!.props.onPress).toEqual({
      kind: "action",
      action: {
        kind: "followUp",
        prompt: "请处理我的报名信息：",
        fields: [
          { label: "姓名", key: "name" },
          { label: "邮箱", key: "email" },
          { label: "公司/团队", key: "company" },
        ],
      },
    });
  });

  it("外围动作:copy/openLink/append/remove 编译与校验", () => {
    const ir = compile([
      'ui.surface("s");',
      'const name = ui.state("name", "string", "x");',
      'const tags = ui.state("tags", "list", ["alpha"]);',
      'ui.node("c", <Button label="复制" onPress={ui.copy(name)} />);',
      'ui.node("l", <Button label="打开" onPress={ui.openLink("https://example.com")} />);',
      'ui.node("a", <Button label="加" onPress={ui.append("tags", "beta")} />);',
      'ui.node("r", <Button label="删" onPress={ui.remove("tags", "beta")} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.nodes.c!.props.onPress).toEqual({ kind: "action", action: { kind: "copy", value: { op: "state", key: "name" } } });
    expect(ir.nodes.l!.props.onPress).toEqual({ kind: "action", action: { kind: "openLink", url: "https://example.com" } });
    expect(ir.nodes.a!.props.onPress).toEqual({ kind: "action", action: { kind: "append", key: "tags", value: { op: "lit", value: "beta" } } });
    fails('ui.surface("s");\nui.node("b", <Button label="x" onPress={ui.openLink("javascript:alert(1)")} />);\nui.end();', "openLink 只允许 http(s)");
    fails([
      'ui.surface("s");',
      'const name = ui.state("name", "string", "x");',
      'ui.node("b", <Button label="x" onPress={ui.append("name", "y")} />);',
      "ui.end();",
    ].join("\n"), "append/remove 需要 list 型状态");
  });

  it("ui.bind 双向绑定:未知 key 与类型不符都拒绝", () => {
    const ir = compile([
      'ui.surface("s");',
      'const name = ui.state("name", "string", "");',
      'ui.node("i", <TextInput label="名称" value={ui.bind("name")} />);',
      "ui.end();",
    ].join("\n"));
    expect(ir.nodes.i!.props.value).toEqual({ kind: "binding", key: "name" });
    fails('ui.surface("s");\nui.node("i", <TextInput label="x" value={ui.bind("ghost")} />);\nui.end();', "绑定引用未知状态 ghost");
    fails([
      'ui.surface("s");',
      'const name = ui.state("name", "string", "");',
      'ui.node("c", <Checkbox label="x" checked={ui.bind("name")} />);',
      "ui.end();",
    ].join("\n"), "需要 boolean 型状态");
  });

  const JSONL_COUNTER = [
    '{"op":"surface.open","surface":"counter","root":"card","fallback":"计数器"}',
    '{"op":"state","key":"count","type":"integer","initial":0}',
    '{"op":"node","id":"card","component":"Card","props":{"title":"计数器","children":["increment"]}}',
    '{"op":"node","id":"increment","component":"Button","props":{"label":"增加","onPress":{"set":"count","value":{"op":"add","left":{"state":"count"},"right":1}}}}',
    '{"op":"surface.close"}',
  ].join("\n");
  const failsJsonl = (source: string, message: string): void => {
    try {
      compileSurface(source, "jsonl");
    } catch (cause) {
      expect(cause).toBeInstanceOf(GenUiError);
      expect((cause as GenUiError).message).toContain(message);
      return;
    }
    throw new Error(`应当编译失败:${message}`);
  };

  it("jsonl 载体降低到同一 IR", () => {
    const ir = compileSurface(JSONL_COUNTER, "jsonl");
    expect(ir.surfaceId).toBe("counter");
    expect(ir.fallback).toBe("计数器");
    expect(ir.rootId).toBe("card");
    expect(ir.states.count).toEqual({ type: "integer", initial: 0 });
    expect(ir.nodes.increment!.props.onPress).toEqual({
      kind: "action",
      action: { kind: "set", key: "count", value: { op: "add", left: { op: "state", key: "count" }, right: { op: "lit", value: 1 } } },
    });
  });

  it("jsonl followUp wire 降低到同一 Action", () => {
    const source = [
      '{"op":"surface.open","surface":"s"}',
      '{"op":"state","key":"note","type":"string","initial":""}',
      '{"op":"node","id":"b","component":"Button","props":{"label":"提交","onPress":{"followUp":"请继续","fields":[{"label":"说明","key":"note"}]}}}',
      '{"op":"surface.close"}',
    ].join("\n");
    const ir = compileSurface(source, "jsonl");
    expect(ir.nodes.b!.props.onPress).toEqual({
      kind: "action",
      action: { kind: "followUp", prompt: "请继续", fields: [{ label: "说明", key: "note" }] },
    });
  });

  it("流式部分编译:未闭合围栏渲染已到齐的行,seal 语义不变", () => {
    const PARTIAL = [
      '{"op":"surface.open","surface":"table","root":"card"}',
      '{"op":"state","key":"rows","type":"list","initial":["张三"]}',
      '{"op":"node","id":"card","component":"Card","props":{"title":"名单","children":["r1"]}}',
      '{"op":"node","id":"r1","component":"Text","props":{"text":"张三"}}',
    ].join("\n");
    const partial = compileSurface(PARTIAL, "jsonl", { final: false });
    expect(Object.keys(partial.nodes)).toEqual(["card", "r1"]);
    failsJsonl(PARTIAL, "缺少 surface.close");
    // children 前向引用未到齐:partial 剪枝渲染,final 具名报错。
    const withGhost = PARTIAL.replace('"children":["r1"]', '"children":["r1","ghost"]') + '\n{"op":"surface.close"}';
    const pruned = compileSurface(withGhost, "jsonl", { final: false });
    expect(pruned.nodes.card!.props.children).toEqual({ kind: "list", items: ["r1"] });
    failsJsonl(withGhost, "引用未知节点 ghost");
    // tsx 侧:缺 ui.end 同样允许 partial、拒绝 final。
    const tsxPartial = compileSurface('ui.surface("s");\nui.node("a", <Text text="x" />);', "tsx", { final: false });
    expect(tsxPartial.order).toEqual(["a"]);
    fails('ui.surface("s");\nui.node("a", <Text text="x" />);', "缺少 ui.end()");
  });

  it("jsonl 结构裁决:未知 op / 缺 close / 非法 JSON / 类型不符都拒绝", () => {
    failsJsonl(JSONL_COUNTER.replace("surface.close", "surface.finish"), "未知的 jsonl op");
    failsJsonl(JSONL_COUNTER.replace(/\n\{"op":"surface\.close"\}/, ""), "缺少 surface.close");
    failsJsonl(JSONL_COUNTER.replace('"surface":"counter"', '"surface":"counter" broken'), "不是合法 JSON");
    failsJsonl(JSONL_COUNTER.replace('"initial":0', '"initial":"零"'), "初始值与类型不符");
    failsJsonl(JSONL_COUNTER.replace('"component":"Button"', '"component":"Widget"'), "未知组件类型");
  });
});

describe("宽容换行与真实模型输出回归", () => {
  it("demo 全家福(省略分号 + 中文拼接 + 全家族组件)编译通过", () => {
    const source = [
      'ui.surface("demo", { title: "QAQ 结构化渲染演示" })',
      "",
      'const count = ui.state("count", "integer", 0)',
      'const name = ui.state("name", "string", "")',
      'const showSecret = ui.state("showSecret", "boolean", false)',
      'const done1 = ui.state("done1", "boolean", false)',
      'const done2 = ui.state("done2", "boolean", false)',
      'const tags = ui.state("tags", "list", ["Card", "Row / Stack", "Metric", "Button", "TextInput", "Checkbox", "TodoList / Todo", "TagList"])',
      'const twice = ui.derive(count * 2)',
      "",
      'ui.node("card_counter", <Card title="① 计数器" children={["stack_counter"]} />)',
      'ui.node("stack_counter", <Stack children={["row_counter", "metric_twice", "text_counter_hint"]} />)',
      'ui.node("row_counter", <Row children={["btn_dec", "metric_count", "btn_inc"]} />)',
      'ui.node("btn_dec", <Button label="-1" disabled={count == 0} onPress={ui.set("count", count - 1)} />)',
      'ui.node("metric_count", <Metric label="当前值" value={count} />)',
      'ui.node("btn_inc", <Button label="+1" onPress={ui.set("count", count + 1)} />)',
      'ui.node("metric_twice", <Metric label="两倍（派生态）" value={twice} />)',
      'ui.node("text_counter_hint", <Text text="试试连点 +1，下面「两倍」会跟着变。" />)',
      'ui.node("card_input", <Card title="② 输入与联动" children={["stack_input"]} />)',
      'ui.node("stack_input", <Stack children={["input_name", "text_greet", "checkbox_secret", "text_secret"]} />)',
      'ui.node("input_name", <TextInput label="你的名字" value={name} placeholder="输入后看下方变化" />)',
      'ui.node("text_greet", <Text text={"你好，" + name + "！"} show={name != ""} />)',
      'ui.node("checkbox_secret", <Checkbox label="显示彩蛋" checked={showSecret} />)',
      'ui.node("text_secret", <Text text="🎉 彩蛋出现了！这就是 show 条件渲染。" show={showSecret} />)',
      'ui.node("card_todo", <Card title="③ 待办清单" children={["todolist_demo"]} />)',
      'ui.node("todolist_demo", <TodoList title="今天" children={["todo1", "todo2"]} />)',
      'ui.node("todo1", <Todo text="点我打勾试试" done={done1} meta="互动" />)',
      'ui.node("todo2", <Todo text="把名字填进 ② 区" done={done2} meta="输入" />)',
      'ui.node("card_actions", <Card title="④ 动作" children={["stack_actions"]} />)',
      'ui.node("stack_actions", <Stack children={["row_actions", "text_actions_hint"]} />)',
      'ui.node("row_actions", <Row children={["btn_followup", "btn_copy", "btn_reset"]} />)',
      'ui.node("btn_followup", <Button label="让 AI 打招呼" onPress={ui.followUp("请用这个名字写一句中文问候语：", { "名字": name })} />)',
      'ui.node("btn_copy", <Button label="复制问候语" onPress={ui.copy("你好，" + name)} />)',
      'ui.node("btn_reset", <Button label="全部重置" onPress={ui.reset()} />)',
      'ui.node("text_actions_hint", <Text text="「让 AI 打招呼」会把上面的名字拼进聊天输入框发给我。" />)',
      'ui.node("card_tags", <Card title="⑤ 已用到的组件" children={["taglist_demo"]} />)',
      'ui.node("taglist_demo", <TagList items={tags} />)',
      "ui.end()",
    ].join("\n");
    const ir = compileSurface(source);
    expect(Object.keys(ir.states)).toEqual(["count", "name", "showSecret", "done1", "done2", "tags"]);
    expect(ir.surfaceId).toBe("demo");
    // derive 内联:twice → count * 2
    expect(ir.nodes.metric_twice!.props.value).toEqual({
      kind: "expr",
      expr: { op: "mul", left: { op: "state", key: "count" }, right: { op: "lit", value: 2 } },
    });
    // 三段拼接(结合律下等价):求值验证而非绑定形状
    const greet = ir.nodes.text_greet!.props.text;
    expect(evaluate((greet as { kind: "expr"; expr: never }).expr, { name: "QAQ" })).toBe("你好，QAQ！");
    // disabled 比较、绑定直写
    expect(ir.nodes.btn_dec!.props.disabled).toEqual({
      kind: "expr",
      expr: { op: "eq", left: { op: "state", key: "count" }, right: { op: "lit", value: 0 } },
    });
    expect(ir.nodes.taglist_demo!.props.items).toEqual({ kind: "binding", key: "tags" });
    expect(ir.nodes.todo1!.props.done).toEqual({ kind: "binding", key: "done1" });
  });

  it("宽容换行不误伤多行语句(括号未闭合时换行继续)", () => {
    const ir = compileSurface([
      "ui.surface(\"s\")",
      'ui.node("a", <Text',
      '  text="跨行" />)',
      'ui.node("b", <Text text="x" />)',
      "ui.end()",
    ].join("\n"));
    expect(ir.order).toEqual(["a", "b"]);
  });

  it("括号未闭合的语句不会在新 ui. 行被切断", () => {
    fails([
      'ui.surface("s")',
      'ui.node("a", <Text text="x" ', // 未闭合,下一行 ui. 不应切
      'ui.node("b", <Text text="y" />)',
      "ui.end()",
    ].join("\n"), "只支持自闭合 JSX");
  });
});

