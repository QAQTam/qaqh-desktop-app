// Compile the actual fixed wrapper for the isolated native WebKitGTK probe.
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync("src/ui/viewTransition.ts", "utf8")
  .replace('import { flush } from "solid-js";', 'const flush = () => { throw new Error("unexpected flush on Linux"); };')
  .replace("export function withViewTransition", "function withViewTransition");
const outputText = stripTypeScriptTypes(source);
const probe = `(() => {
  ${outputText}
  document.documentElement.dataset.platform = "linux";
  document.documentElement.dataset.perfMode = "normal";
  const native = document.startViewTransition.bind(document);
  let nativeCalls = 0;
  document.startViewTransition = (...args) => { nativeCalls++; return native(...args); };
  let updates = 0;
  for (let i = 0; i < 100; i++) {
    withViewTransition(() => { updates++; document.body.textContent = "update " + updates; });
  }
  if (updates !== 100 || nativeCalls !== 0) throw new Error("unsafe wrapper path");
  return JSON.stringify({ updates, nativeCalls, text: document.body.textContent });
})()`;
writeFileSync("artifacts/diagnostics/fixed-transition-probe.js", probe);
