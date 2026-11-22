import { join } from "@std/path";
import type { Rate } from "./units.ts";

export interface Limits {
  download: Rate | null;
  upload: Rate | null;
}

export interface Settings {
  /** Interface to open without asking, when the user chose to remember it. */
  interface: string | null;
  showBits: boolean;
  restoreLimits: boolean;
  /** Saved limits by program name. */
  limits: Record<string, Limits>;
  globalLimits: Limits;
}

const DEFAULTS: Settings = {
  interface: null,
  showBits: false,
  restoreLimits: true,
  limits: {},
  globalLimits: { download: null, upload: null },
};

function configDir(): string {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  return join(xdg ?? join(Deno.env.get("HOME") ?? ".", ".config"), "bandito");
}

const FILE = join(configDir(), "settings.json");

function rate(value: unknown): Rate | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function limits(value: unknown): Limits {
  const v = (value ?? {}) as Record<string, unknown>;
  return { download: rate(v.download), upload: rate(v.upload) };
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(FILE));
    const saved: Record<string, Limits> = {};
    for (const [name, value] of Object.entries(raw.limits ?? {})) {
      const l = limits(value);
      if (l.download !== null || l.upload !== null) saved[name] = l;
    }
    return {
      interface: typeof raw.interface === "string" ? raw.interface : null,
      showBits: raw.showBits === true,
      restoreLimits: raw.restoreLimits !== false,
      limits: saved,
      globalLimits: limits(raw.globalLimits),
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Save soon, so a burst of edits writes the file once. */
export function saveSettings(settings: Settings): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    saveSettingsNow(settings);
  }, 500);
}

export function saveSettingsNow(settings: Settings): void {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  try {
    Deno.mkdirSync(configDir(), { recursive: true });
    Deno.writeTextFileSync(FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    console.error("Could not save settings:", e);
  }
}
