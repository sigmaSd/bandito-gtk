import { TextLineStream } from "@std/streams";
import { isFlatpak } from "../utils/flatpak.ts";
import { UNKNOWN_PROCESS } from "../model/identity.ts";
import type { Limits } from "../model/settings.ts";
import type { ConnectionSample, Sample } from "../model/store.ts";
import type { Backend, BackendEvents, LimitTarget } from "./types.ts";
import type { Launch } from "../utils/binary_manager.ts";

/** pkexec exits with 126 when the password prompt is dismissed. */
const AUTH_REFUSED = 126;

/** What netleash reports once a second. */
export interface HelperSample {
  interface: string | null;
  total: { rx: number; tx: number };
  apps: {
    id: string;
    kind: string;
    rx: number;
    tx: number;
    /** Sent by netleash after 0.2.1. */
    processTraffic?: { pid: number; name: string; rx: number; tx: number }[];
  }[];
  connections: {
    app: string;
    protocol: string;
    remote: string;
    host: string | null;
    remotePort: number;
    localPort: number;
    rx: number;
    tx: number;
  }[];
}

/**
 * Turn a helper sample into Bandito's. Traffic on the interface that no
 * local socket owned (forwarded, ICMP, kernel) becomes unidentified traffic.
 */
export function convert(
  sample: HelperSample,
): { samples: Sample[]; connections: ConnectionSample[] } {
  const samples: Sample[] = sample.apps.map((app) => ({
    name: app.id,
    download: app.rx,
    upload: app.tx,
    ...app.processTraffic && {
      processes: app.processTraffic.map((p) => ({
        pid: p.pid,
        name: p.name,
        download: p.rx,
        upload: p.tx,
      })),
    },
  }));
  const owned = sample.apps.reduce(
    (sum, app) => ({ rx: sum.rx + app.rx, tx: sum.tx + app.tx }),
    { rx: 0, tx: 0 },
  );
  const rest = {
    rx: Math.max(0, sample.total.rx - owned.rx),
    tx: Math.max(0, sample.total.tx - owned.tx),
  };
  if (rest.rx > 0 || rest.tx > 0) {
    samples.push({ name: UNKNOWN_PROCESS, download: rest.rx, upload: rest.tx });
  }
  const connections: ConnectionSample[] = sample.connections
    .filter((c) => c.protocol === "tcp" || c.protocol === "udp")
    .map((c) => ({
      process: c.app,
      protocol: c.protocol as "tcp" | "udp",
      host: c.host ?? c.remote,
      remotePort: c.remotePort,
      localPort: c.localPort,
      download: c.rx,
      upload: c.tx,
    }));
  return { samples, connections };
}

/** How Bandito runs netleash. */
export type NetleashPlan =
  /** A netleash with its file capabilities: run as the user, no prompt. */
  | { kind: "capable"; command: string[] }
  /** NETLEASH set to a binary without them: run it through pkexec. */
  | { kind: "override"; command: string[] }
  /** Download the pinned netleash, check it, run it as root via pkexec. */
  | { kind: "pinned" };

/** Run a command on the host, outside the Flatpak sandbox if in one. */
function onHost(args: string[]): string[] {
  return isFlatpak() ? ["flatpak-spawn", "--host", ...args] : args;
}

/** Whether a netleash binary can run without root (`netleash --capable`). */
function capable(path: string): boolean {
  try {
    const [command, ...args] = onHost([path, "--capable"]);
    return new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

/** netleash on the host's PATH, if any. */
function onPath(): string | null {
  try {
    const [command, ...args] = onHost(["sh", "-c", "command -v netleash"]);
    const output = new Deno.Command(command, { args, stderr: "null" })
      .outputSync();
    const path = new TextDecoder().decode(output.stdout).trim();
    return output.success && path ? path : null;
  } catch {
    return null;
  }
}

/**
 * How to run netleash. In order: NETLEASH; a netleash with its capabilities
 * on the PATH; otherwise the pinned download. A netleash without capabilities on the
 * PATH is never run through pkexec: it may sit in a user-writable directory
 * such as ~/.cargo/bin, which is why the pinned copy is checked as root
 * before it runs.
 */
export function chooseNetleash(options: {
  env?: string;
  path: string | null;
  capable: (path: string) => boolean;
  flatpak: boolean;
}): NetleashPlan {
  const host = (args: string[]) =>
    options.flatpak ? ["flatpak-spawn", "--host", ...args] : args;
  if (options.env) {
    return options.capable(options.env)
      ? { kind: "capable", command: host([options.env]) }
      : { kind: "override", command: host(["pkexec", options.env]) };
  }
  if (options.path && options.capable(options.path)) {
    return { kind: "capable", command: host([options.path]) };
  }
  return { kind: "pinned" };
}

/** chooseNetleash() for this machine. */
export function netleashPlan(): NetleashPlan {
  return chooseNetleash({
    env: Deno.env.get("NETLEASH"),
    path: onPath(),
    capable,
    flatpak: isFlatpak(),
  });
}

/**
 * Measures and limits traffic with netleash, one eBPF program for both
 * jobs, started with the launch `launch` gives when monitoring starts.
 */
export class EbpfBackend implements Backend {
  #process: Deno.ChildProcess | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #stopping = false;
  /** Resolves true once netleash says it's ready, false if it exits first. */
  #ready: Promise<boolean> = Promise.resolve(false);
  readonly #launch: () => Launch;

  constructor(launch: () => Launch) {
    this.#launch = launch;
  }

  async start(iface: string, events: BackendEvents): Promise<void> {
    const { command: [command, ...args], script } = this.#launch();
    const process = new Deno.Command(command, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    this.#process = process;
    this.#writer = process.stdin.getWriter();
    this.#stopping = false;
    let lastError = "";
    let markReady: (ready: boolean) => void = () => {};
    this.#ready = new Promise((resolve) => (markReady = resolve));
    process.status.then(() => markReady(false));
    // The root-side check goes first. Commands wait for netleash's "ready":
    // a shell such as dash reads stdin in blocks and would swallow them.
    if (script) {
      await this.#writer.write(new TextEncoder().encode(script));
    }

    process.status.then((status) => {
      if (this.#stopping || this.#process !== process) return;
      events.failure(
        status.code === AUTH_REFUSED
          ? "Administrator access was not granted, so traffic can't be measured."
          : lastError ||
            `The traffic helper stopped (exit code ${status.code}).`,
      );
    });

    (async () => {
      const lines = process.stdout
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());
      const seen = new Set<string>();
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "ready") {
          markReady(true);
        } else if (event.type === "sample") {
          const { samples, connections } = convert(event as HelperSample);
          events.sample(samples, connections);
          for (const { name } of samples) {
            if (name !== UNKNOWN_PROCESS && !seen.has(name)) {
              seen.add(name);
              events.program(name);
            }
          }
        } else if (event.type === "error") {
          lastError = event.message;
          console.error("netleash:", event.message);
        }
      }
    })().catch((e) => {
      if (!this.#stopping) console.error("netleash stream error:", e);
    });

    await this.#send({ cmd: "interface", name: iface });
  }

  async #send(command: unknown): Promise<void> {
    if (!(await this.#ready) || !this.#writer) {
      throw new Error("The traffic helper isn't running.");
    }
    await this.#writer.write(
      new TextEncoder().encode(JSON.stringify(command) + "\n"),
    );
  }

  async switchInterface(iface: string): Promise<void> {
    await this.#send({ cmd: "interface", name: iface });
  }

  async setLimits(target: LimitTarget, limits: Limits): Promise<void> {
    const rate = (value: number | null) =>
      value === null ? null : Math.max(1, Math.round(value));
    await this.#send({
      cmd: "limit",
      app: target.kind === "app" ? target.name : null,
      down: rate(limits.download),
      up: rate(limits.upload),
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const process = this.#process;
    this.#process = null;
    if (!process) return;
    // Still at the password prompt: there's nothing to stop yet.
    const started = await Promise.race([
      this.#ready,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);
    if (!started) {
      try {
        process.kill();
      } catch {
        // Already gone.
      }
    }
    try {
      if (started) await this.#send({ cmd: "stop" });
      await this.#writer?.close();
    } catch {
      // Already gone.
    }
    this.#writer = null;
    await process.status;
  }
}
