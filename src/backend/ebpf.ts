import { TextLineStream } from "@std/streams";
import { isFlatpak } from "../utils/flatpak.ts";
import { UNKNOWN_PROCESS } from "../model/identity.ts";
import type { Limits } from "../model/settings.ts";
import type { ConnectionSample, Sample } from "../model/store.ts";
import type { Backend, BackendEvents, LimitTarget } from "./types.ts";

/** pkexec exits with 126 when the password prompt is dismissed. */
const AUTH_REFUSED = 126;

/** What bandito-helper reports once a second. */
export interface HelperSample {
  interface: string | null;
  total: { rx: number; tx: number };
  apps: { id: string; kind: string; rx: number; tx: number }[];
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

/**
 * Measures and limits traffic with bandito-helper, one eBPF program for both
 * jobs. Opt in with BANDITO_BACKEND=ebpf and BANDITO_HELPER set to the
 * helper's path.
 */
export class EbpfBackend implements Backend {
  #process: Deno.ChildProcess | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #stopping = false;

  async start(iface: string, events: BackendEvents): Promise<void> {
    const helper = Deno.env.get("BANDITO_HELPER");
    if (!helper) {
      throw new Error("Set BANDITO_HELPER to bandito-helper's path.");
    }
    const [command, ...args] = isFlatpak()
      ? ["flatpak-spawn", "--host", "pkexec", helper]
      : ["pkexec", helper];
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
        if (event.type === "sample") {
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
          console.error("bandito-helper:", event.message);
        }
      }
    })().catch((e) => {
      if (!this.#stopping) console.error("bandito-helper stream error:", e);
    });

    await this.#send({ cmd: "interface", name: iface });
  }

  async #send(command: unknown): Promise<void> {
    if (!this.#writer) throw new Error("The traffic helper isn't running.");
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
    try {
      await this.#send({ cmd: "stop" });
      await this.#writer?.close();
    } catch {
      // Already gone.
    }
    this.#writer = null;
    await process.status;
  }
}
