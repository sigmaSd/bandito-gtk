import type { Limits } from "./settings.ts";
import type { Rate } from "./units.ts";

/** Samples kept per app for its sparkline (one per second). */
export const APP_HISTORY = 30;
/** Samples kept for the total chart. */
export const TOTAL_HISTORY = 60;
/** An app counts as idle after this many samples without traffic. */
export const IDLE_AFTER = 15;
/** Connections stay listed this many samples after their last traffic. */
export const CONNECTION_MEMORY = 60;
/** Processes stay in an app's panel this many samples after their traffic. */
export const PROCESS_MEMORY = 60;
/** Processes stay under their app in the list this many quiet samples. */
export const PROCESS_LINGER = 3;
/** Processes shown under an app in the list; the rest count as "Other". */
export const LISTED_PROCESSES = 4;
/** Traffic no process accounts for, below this, is rounding. */
const OTHER_MIN = 500;

/** One second of one process's traffic, from the process that made a socket. */
export interface ProcessSample {
  pid: number;
  name: string;
  download: Rate;
  upload: Rate;
}

export interface Sample {
  name: string;
  download: Rate;
  upload: Rate;
  /** Split by process, when netleash reports it (0.2.1 and earlier don't). */
  processes?: ProcessSample[];
}

export interface ProcessInfo extends ProcessSample {
  /** Samples since this process last had traffic. */
  quietFor: number;
}

/** A line under an app in the list: a process, or the rest of its traffic. */
export interface ProcessLine {
  /** null for the traffic no listed process accounts for. */
  pid: number | null;
  name: string;
  download: Rate;
  upload: Rate;
}

/** One second of traffic on one connection. */
export interface ConnectionSample {
  process: string;
  protocol: "tcp" | "udp";
  /** Remote host name when it resolved, otherwise its address. */
  host: string;
  remotePort: number;
  localPort: number;
  download: Rate;
  upload: Rate;
}

export interface ConnectionInfo extends ConnectionSample {
  /** Bytes moved since Bandito first saw this connection. */
  total: number;
  /** Samples since this connection last had traffic. */
  quietFor: number;
}

export interface AppEntry {
  /** App or service id reported by netleash. */
  readonly name: string;
  download: Rate;
  upload: Rate;
  /** Oldest first: [download, upload] per sample. */
  history: [Rate, Rate][];
  /** Samples since this app last had traffic. */
  quietFor: number;
  limits: Limits;
  /** Recent connections by protocol, host and ports. */
  connections: Map<string, ConnectionInfo>;
  /** Whether netleash ever split this app's traffic by process. */
  hasProcesses: boolean;
  /** Recent processes by PID. */
  processes: Map<number, ProcessInfo>;
  /** Traffic no process accounted for: sockets netleash didn't see made. */
  other: { download: Rate; upload: Rate; quietFor: number };
}

export interface Totals {
  download: Rate;
  upload: Rate;
  history: [Rate, Rate][];
  limits: Limits;
}

export const noLimits = (): Limits => ({ download: null, upload: null });

export function hasLimit(limits: Limits): boolean {
  return limits.download !== null || limits.upload !== null;
}

/** Traffic per app and in total, updated from monitor samples. */
export class Store {
  readonly apps = new Map<string, AppEntry>();
  readonly totals: Totals = {
    download: 0,
    upload: 0,
    history: [],
    limits: noLimits(),
  };

  onAdded: (entry: AppEntry) => void = () => {};
  onSample: () => void = () => {};

  ensure(name: string): AppEntry {
    let entry = this.apps.get(name);
    if (!entry) {
      entry = {
        name,
        download: 0,
        upload: 0,
        history: [],
        quietFor: IDLE_AFTER,
        limits: noLimits(),
        connections: new Map(),
        hasProcesses: false,
        processes: new Map(),
        other: { download: 0, upload: 0, quietFor: IDLE_AFTER },
      };
      this.apps.set(name, entry);
      this.onAdded(entry);
    }
    return entry;
  }

  isActive(entry: AppEntry): boolean {
    return entry.quietFor < IDLE_AFTER || hasLimit(entry.limits);
  }

  activeCount(): number {
    let count = 0;
    for (const entry of this.apps.values()) {
      if (entry.quietFor < IDLE_AFTER) count++;
    }
    return count;
  }

  /** Busiest first, then the most recently active. */
  recentConnections(entry: AppEntry, limit = 12): ConnectionInfo[] {
    return [...entry.connections.values()]
      .sort((a, b) =>
        (b.download + b.upload) - (a.download + a.upload) ||
        a.quietFor - b.quietFor || b.total - a.total
      )
      .slice(0, limit);
  }

  /** An app's processes for its panel: busiest, then most recent. */
  recentProcesses(entry: AppEntry, limit = 12): ProcessInfo[] {
    return [...entry.processes.values()]
      .sort((a, b) =>
        (b.download + b.upload) - (a.download + a.upload) ||
        a.quietFor - b.quietFor || a.pid - b.pid
      )
      .slice(0, limit);
  }

  /**
   * Lines to show under an app in the list, busiest first, or none when a
   * single process (or nothing known) accounts for its traffic. Processes
   * that just went quiet stay a moment, so lines don't flicker.
   */
  processLines(entry: AppEntry): ProcessLine[] {
    if (!entry.hasProcesses) return [];
    const recent = this.recentProcesses(entry, Infinity)
      .filter((p) => p.quietFor < PROCESS_LINGER);
    const lines: ProcessLine[] = recent.slice(0, LISTED_PROCESSES)
      .map(({ pid, name, download, upload }) => ({
        pid,
        name,
        download,
        upload,
      }));
    const rest = { download: 0, upload: 0 };
    for (const p of recent.slice(LISTED_PROCESSES)) {
      rest.download += p.download;
      rest.upload += p.upload;
    }
    if (entry.other.quietFor < PROCESS_LINGER) {
      rest.download += entry.other.download;
      rest.upload += entry.other.upload;
    }
    if (
      recent.length > LISTED_PROCESSES || entry.other.quietFor < PROCESS_LINGER
    ) {
      lines.push({ pid: null, name: "Other", ...rest });
    }
    return lines.length >= 2 ? lines : [];
  }

  #applyProcesses(entry: AppEntry, sample: Sample | undefined) {
    for (const [pid, info] of entry.processes) {
      info.download = 0;
      info.upload = 0;
      info.quietFor++;
      if (info.quietFor > PROCESS_MEMORY) entry.processes.delete(pid);
    }
    const other = entry.other;
    other.download = 0;
    other.upload = 0;
    other.quietFor++;
    if (!sample?.processes) return;
    entry.hasProcesses = true;
    let download = 0;
    let upload = 0;
    for (const p of sample.processes) {
      download += p.download;
      upload += p.upload;
      const info = entry.processes.get(p.pid);
      if (info && info.quietFor === 0) {
        info.download += p.download;
        info.upload += p.upload;
      } else {
        entry.processes.set(p.pid, { ...p, quietFor: 0 });
      }
    }
    other.download = Math.max(0, sample.download - download);
    other.upload = Math.max(0, sample.upload - upload);
    if (other.download + other.upload >= OTHER_MIN) other.quietFor = 0;
    else {
      other.download = 0;
      other.upload = 0;
    }
  }

  #applyConnections(connections: ConnectionSample[]) {
    for (const entry of this.apps.values()) {
      for (const [key, info] of entry.connections) {
        info.download = 0;
        info.upload = 0;
        info.quietFor++;
        if (info.quietFor > CONNECTION_MEMORY) entry.connections.delete(key);
      }
    }
    for (const c of connections) {
      const entry = this.ensure(c.process);
      const key = `${c.protocol}|${c.host}|${c.remotePort}|${c.localPort}`;
      const info = entry.connections.get(key);
      if (info) {
        info.download += c.download;
        info.upload += c.upload;
        info.total += c.download + c.upload;
        info.quietFor = 0;
      } else {
        entry.connections.set(key, {
          ...c,
          total: c.download + c.upload,
          quietFor: 0,
        });
      }
    }
  }

  /** Record one second of traffic. Apps missing from the sample had none. */
  applySample(samples: Sample[], connections: ConnectionSample[] = []): void {
    this.#applyConnections(connections);
    const seen = new Map<string, Sample>();
    for (const sample of samples) {
      const previous = seen.get(sample.name);
      seen.set(
        sample.name,
        previous
          ? {
            name: sample.name,
            download: previous.download + sample.download,
            upload: previous.upload + sample.upload,
            processes: previous.processes || sample.processes
              ? [...previous.processes ?? [], ...sample.processes ?? []]
              : undefined,
          }
          : sample,
      );
    }
    for (const name of seen.keys()) this.ensure(name);

    let download = 0;
    let upload = 0;
    for (const entry of this.apps.values()) {
      const sample = seen.get(entry.name);
      entry.download = sample?.download ?? 0;
      entry.upload = sample?.upload ?? 0;
      entry.history.push([entry.download, entry.upload]);
      if (entry.history.length > APP_HISTORY) entry.history.shift();
      entry.quietFor = entry.download + entry.upload > 0
        ? 0
        : entry.quietFor + 1;
      this.#applyProcesses(entry, sample);
      download += entry.download;
      upload += entry.upload;
    }
    this.totals.download = download;
    this.totals.upload = upload;
    this.totals.history.push([download, upload]);
    if (this.totals.history.length > TOTAL_HISTORY) {
      this.totals.history.shift();
    }
    this.onSample();
  }

  /** Forget traffic history, e.g. after switching interfaces. */
  resetHistory(): void {
    this.totals.history = [];
    this.totals.download = 0;
    this.totals.upload = 0;
    for (const entry of this.apps.values()) {
      entry.history = [];
      entry.download = 0;
      entry.upload = 0;
      entry.quietFor = IDLE_AFTER;
      entry.connections.clear();
      entry.processes.clear();
      entry.other = { download: 0, upload: 0, quietFor: IDLE_AFTER };
    }
  }
}
