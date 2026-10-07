/** Local visual preferences. These values are intentionally separate from daemon config. */
import { createSignal } from "solid-js";

export type SessionMaterial = "glass" | "solid";
const STORAGE_KEY = "qaqh.visual.sessionMaterial";

function readMaterial(): SessionMaterial {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "solid" ? "solid" : "glass";
  } catch {
    return "glass";
  }
}

const [sessionMaterial, setSessionMaterialSignal] = createSignal<SessionMaterial>(readMaterial());

function applyMaterial(value: SessionMaterial): void {
  if (typeof document !== "undefined") document.documentElement.dataset.material = value;
}

applyMaterial(sessionMaterial());

export function setSessionMaterial(value: SessionMaterial): void {
  setSessionMaterialSignal(value);
  applyMaterial(value);
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // The preference still applies to this window when storage is unavailable.
  }
}

export { sessionMaterial };
