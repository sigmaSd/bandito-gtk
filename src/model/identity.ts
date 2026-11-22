import { type AppIcon, AppInfo, DesktopAppInfo } from "@sigmasd/gtk/gio";

/** How a process is shown: a readable name, a hint, and an icon if known. */
export interface Identity {
  title: string;
  subtitle: string;
  icon: AppIcon | null;
  /** Whether netleash can limit this app's traffic. */
  limitable: boolean;
  /** Text matched by search. */
  keywords: string;
}

export const UNKNOWN_PROCESS = "<UNKNOWN>";

interface Candidate {
  title: string;
  icon: AppIcon | null;
}

let index: Map<string, Candidate> | null = null;

function basename(path: string): string {
  const first = path.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1).toLowerCase();
}

function buildIndex(): Map<string, Candidate> {
  const map = new Map<string, Candidate>();
  const add = (key: string | null | undefined, candidate: Candidate) => {
    if (!key) return;
    const k = key.toLowerCase();
    if (!map.has(k)) map.set(k, candidate);
  };
  let apps: AppInfo[] = [];
  try {
    apps = AppInfo.getAll();
  } catch (e) {
    console.error("Could not list installed applications:", e);
  }
  // Visible launchers win over hidden helpers that share an executable.
  apps.sort((a, b) => Number(b.shouldShow()) - Number(a.shouldShow()));
  for (const app of apps) {
    let candidate: Candidate;
    try {
      candidate = { title: app.getDisplayName(), icon: app.getIcon() };
    } catch {
      continue;
    }
    const id = app.getId()?.replace(/\.desktop$/, "") ?? "";
    const exe = basename(app.getExecutable());
    // Flatpak and other launchers run a wrapper; the app ID still names it.
    if (!["flatpak", "env", "sh", "bash", "snap"].includes(exe)) {
      add(exe, candidate);
    }
    add(id, candidate);
    add(id.slice(id.lastIndexOf(".") + 1), candidate);
    if (id && DesktopAppInfo.isSupported()) {
      try {
        add(
          DesktopAppInfo.fromId(`${id}.desktop`)?.getStartupWmClass(),
          candidate,
        );
      } catch {
        // Some launchers can't be reopened by ID; their executable is enough.
      }
    }
  }
  return map;
}

function lookup(name: string): Candidate | null {
  index ??= buildIndex();
  const key = name.toLowerCase();
  const direct = index.get(key);
  if (direct) return direct;
  // Linux truncates process names to 15 characters.
  if (key.length === 15) {
    for (const [k, candidate] of index) {
      if (k.startsWith(key)) return candidate;
    }
  }
  return null;
}

const cache = new Map<string, Identity>();

/** Match a process name to an installed application where possible. */
export function identify(name: string): Identity {
  const cached = cache.get(name);
  if (cached) return cached;
  let identity: Identity;
  if (name === UNKNOWN_PROCESS) {
    identity = {
      title: "Unidentified traffic",
      subtitle: "Not matched to a program",
      icon: null,
      limitable: false,
      keywords: "unknown unidentified",
    };
  } else {
    const match = lookup(name);
    identity = match
      ? {
        title: match.title,
        subtitle: match.title.toLowerCase() === name.toLowerCase()
          ? "Application"
          : name,
        icon: match.icon,
        limitable: true,
        keywords: `${match.title} ${name}`.toLowerCase(),
      }
      : {
        title: name,
        subtitle: name === "AppRun" ? "AppImage" : "Program",
        icon: null,
        limitable: true,
        keywords: name.toLowerCase(),
      };
  }
  cache.set(name, identity);
  return identity;
}
