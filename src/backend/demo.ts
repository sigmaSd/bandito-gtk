import type { Limits } from "../model/settings.ts";
import type { ConnectionSample, Sample } from "../model/store.ts";
import type { Backend, BackendEvents, LimitTarget } from "./types.ts";

/**
 * Simulated traffic for trying the interface without root, binaries or a
 * busy network. Enable with BANDITO_DEMO=1.
 */
interface DemoApp {
  name: string;
  download: number;
  upload: number;
  /** Chance per second of a burst, or of a short blip for idle apps. */
  burst: number;
  blip: number;
  current: [number, number];
  limits: Limits;
}

const APPS: Omit<DemoApp, "current" | "limits">[] = [
  { name: "steam", download: 4.4e6, upload: 28e3, burst: 0.05, blip: 0 },
  {
    name: "org.gnome.Ptyxis",
    download: 1.6e6,
    upload: 90e3,
    burst: 0.1,
    blip: 0,
  },
  { name: "firefox", download: 620e3, upload: 34e3, burst: 0.25, blip: 0 },
  { name: "syncthing", download: 60e3, upload: 880e3, burst: 0.1, blip: 0 },
  { name: "chrome", download: 140e3, upload: 12e3, burst: 0.3, blip: 0 },
  { name: "<UNKNOWN>", download: 8e3, upload: 300, burst: 0.2, blip: 0 },
  { name: "opencode", download: 1.4e3, upload: 900, burst: 0.4, blip: 0 },
  { name: "NetworkManager", download: 220, upload: 140, burst: 0.1, blip: 0 },
  { name: "gh", download: 0, upload: 0, burst: 0, blip: 0.08 },
  { name: "gnome-software", download: 0, upload: 0, burst: 0, blip: 0.04 },
  { name: "AppRun", download: 0, upload: 0, burst: 0, blip: 0.03 },
  { name: "curl", download: 0, upload: 0, burst: 0, blip: 0.02 },
  { name: "flatpak", download: 0, upload: 0, burst: 0, blip: 0.01 },
];

/**
 * Processes splitting an app's simulated traffic, as netleash reports them:
 * name, PID and share. What the shares leave over has no known process.
 */
const PROCESSES: Record<string, [string, number, number][]> = {
  steam: [["steam", 4120, 1]],
  firefox: [["firefox", 3311, 1]],
  "org.gnome.Ptyxis": [["wget", 52107, 0.8], ["git", 52230, 0.15]],
  syncthing: [["syncthing", 1874, 1]],
};

/**
 * A curl in the demo terminal: it downloads for CURL_RUN of every CURL_CYCLE
 * seconds, taking part of wget's share, with a new PID each time.
 */
const CURL_CYCLE = 20;
const CURL_RUN = 8;
const CURL_SHARE = 0.25;

function curlPid(tick: number): number {
  return 60000 + Math.floor(tick / CURL_CYCLE);
}

function withProcesses(sample: Sample, tick: number): Sample {
  let processes = PROCESSES[sample.name];
  if (!processes) return sample;
  if (sample.name === "org.gnome.Ptyxis" && tick % CURL_CYCLE < CURL_RUN) {
    processes = processes.map(([name, pid, share]): [string, number, number] =>
      name === "wget" ? [name, pid, share - CURL_SHARE] : [name, pid, share]
    );
    processes.push(["curl", curlPid(tick), CURL_SHARE]);
  }
  return {
    ...sample,
    processes: processes.map(([name, pid, share]) => ({
      pid,
      name,
      download: Math.round(sample.download * share),
      upload: Math.round(sample.upload * share),
    })),
  };
}

/** Where each app's simulated traffic goes: host, port and protocol. */
const ENDPOINTS: Record<string, [string, number, "tcp" | "udp"][]> = {
  steam: [
    ["cache11-fra2.steamcontent.com", 443, "tcp"],
    ["cache4-ams1.steamcontent.com", 443, "tcp"],
    ["api.steampowered.com", 443, "tcp"],
  ],
  firefox: [
    ["www.youtube.com", 443, "tcp"],
    ["rr3---sn-4g5e6nsz.googlevideo.com", 443, "udp"],
    ["github.com", 443, "tcp"],
  ],
  syncthing: [["192.168.1.24", 22000, "tcp"], [
    "relay.syncthing.net",
    443,
    "tcp",
  ]],
  chrome: [["mail.google.com", 443, "tcp"], ["fonts.gstatic.com", 443, "udp"]],
  "<UNKNOWN>": [
    ["224.0.0.251", 5353, "udp"],
    ["239.255.255.250", 1900, "udp"],
    ["fe80::1", 53, "udp"],
  ],
  opencode: [["api.anthropic.com", 443, "tcp"]],
  "org.gnome.Ptyxis": [
    ["download.fedoraproject.org", 443, "tcp"],
    ["github.com", 443, "tcp"],
  ],
  NetworkManager: [["connectivity-check.ubuntu.com", 80, "tcp"]],
  gh: [["api.github.com", 443, "tcp"]],
  "gnome-software": [["dl.flathub.org", 443, "tcp"]],
  AppRun: [["sync.obsidian.md", 443, "tcp"]],
  curl: [["deb.debian.org", 80, "tcp"]],
  flatpak: [["dl.flathub.org", 443, "tcp"]],
};

const jitter = () => 0.55 + Math.random() * 0.9;

function spread(samples: Sample[]): ConnectionSample[] {
  const connections: ConnectionSample[] = [];
  for (const sample of samples) {
    const endpoints = ENDPOINTS[sample.name] ?? [];
    const weights = endpoints.map((_, i) => (i === 0 ? 3 : 1) * Math.random());
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    endpoints.forEach(([host, remotePort, protocol], i) => {
      const share = weights[i] / sum;
      connections.push({
        process: sample.name,
        host,
        remotePort,
        protocol,
        localPort: 40000 + ((host.length * 997 + i * 131) % 20000),
        download: Math.round(sample.download * share),
        upload: Math.round(sample.upload * share),
      });
    });
  }
  return connections;
}

export class DemoBackend implements Backend {
  #apps: DemoApp[] = APPS.map((a) => ({
    ...a,
    current: [a.download, a.upload],
    limits: { download: null, upload: null },
  }));
  #global: Limits = { download: null, upload: null };
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticks = 0;

  start(_iface: string, events: BackendEvents): Promise<void> {
    for (const app of this.#apps) events.program(app.name);
    this.#timer = setInterval(() => {
      const tick = this.#ticks++;
      const samples = this.#tick(tick);
      // netleash reports an exit once the process's sockets went quiet.
      const exited = tick % CURL_CYCLE === CURL_RUN + 1 ? [curlPid(tick)] : [];
      events.sample(samples, spread(samples), exited);
    }, 1000);
    return Promise.resolve();
  }

  #tick(tick: number): Sample[] {
    const samples: Sample[] = [];
    for (const app of this.#apps) {
      let down = 0;
      let up = 0;
      if (app.download > 0) {
        const burst = Math.random() < app.burst ? 2.4 : 1;
        down = app.download * jitter() * burst;
        up = app.upload * jitter() * burst;
      }
      if (Math.random() < app.blip) {
        down += 2e3 + Math.random() * 60e3;
        up += 300 + Math.random() * 5e3;
      }
      app.current = [
        app.current[0] * 0.45 + down * 0.55,
        app.current[1] * 0.45 + up * 0.55,
      ];
      const cap = (value: number, limit: number | null) =>
        limit === null
          ? value
          : Math.min(value, limit * (0.96 + Math.random() * 0.04));
      const download = cap(app.current[0], app.limits.download);
      const upload = cap(app.current[1], app.limits.upload);
      if (download >= 25 || upload >= 25) {
        samples.push({ name: app.name, download, upload });
      }
    }
    for (const key of ["download", "upload"] as const) {
      const limit = this.#global[key];
      const total = samples.reduce((sum, s) => sum + s[key], 0);
      if (limit !== null && total > limit) {
        const factor = limit / total * (0.96 + Math.random() * 0.04);
        for (const s of samples) s[key] *= factor;
      }
    }
    return samples.map((sample) => withProcesses(sample, tick));
  }

  switchInterface(_iface: string): Promise<void> {
    return Promise.resolve();
  }

  setLimits(target: LimitTarget, limits: Limits): Promise<void> {
    if (target.kind === "global") this.#global = { ...limits };
    else {
      const app = this.#apps.find((a) => a.name === target.name);
      if (app) app.limits = { ...limits };
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    return Promise.resolve();
  }
}
