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

export interface Sample {
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
    }
  }
}
