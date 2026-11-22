import { TextDelimiterStream } from "@std/streams";
import { getBinaryPath } from "../utils/binary_manager.ts";
import { isFlatpak } from "../utils/flatpak.ts";
import type { ConnectionSample, Sample } from "../model/store.ts";

/** Runs `bandwhich --raw` as root and reports per-process rates. */
export class Bandwhich {
  #reader: ReadableStreamDefaultReader<string> | null = null;
  #process: Deno.ChildProcess | null = null;
  #stopping = false;

  /**
   * Start monitoring. `onExit` runs if bandwhich stops by itself, with how
   * long it ran, so a refused password prompt can be told apart from a crash.
   */
  start(
    interfaceName: string,
    onSample: (samples: Sample[], connections: ConnectionSample[]) => void,
    onExit: (code: number, ranForMs: number) => void,
  ): void {
    const binary = getBinaryPath("bandwhich");
    // Processes and connections; connections carry the remote host and port.
    const args = ["-p", "-c", "--raw", "-i", interfaceName];
    const [command, ...prefix] = isFlatpak()
      ? ["flatpak-spawn", "--host", "pkexec", binary]
      : ["pkexec", binary];
    const process = new Deno.Command(command, {
      args: [...prefix, ...args],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#process = process;
    this.#stopping = false;
    const started = performance.now();

    (async () => {
      for await (const chunk of process.stderr) {
        if (!this.#stopping) await Deno.stderr.write(chunk);
      }
    })().catch(() => {});

    process.status.then((status) => {
      if (this.#stopping || this.#process !== process) return;
      onExit(status.code, performance.now() - started);
    });

    const reader = process.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextDelimiterStream("\n\n"))
      .getReader();
    this.#reader = reader;
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done || this.#stopping) break;
        const { samples, connections } = parse(value);
        onSample(samples, connections);
      }
    })().catch((e) => {
      if (!this.#stopping) console.error("bandwhich stream error:", e);
    });
  }

  /** Close bandwhich's output; it exits on its next write. */
  async stop(): Promise<void> {
    this.#stopping = true;
    const reader = this.#reader;
    this.#reader = null;
    this.#process = null;
    try {
      await reader?.cancel();
    } catch {
      // Already closed.
    }
  }
}

const PROCESS =
  /^process: <\d+> "(.*)" up\/down Bps: (\d+)\/(\d+) connections: \d+$/;
const CONNECTION =
  /^connection: <\d+> <[^>]*>:(\d+) => (.+):(\d+) \((tcp|udp)\) up\/down Bps: (\d+)\/(\d+) process: "(.*)"$/;

/** Parse one `--raw` refresh. Rates are bytes in the last second. */
export function parse(
  data: string,
): { samples: Sample[]; connections: ConnectionSample[] } {
  const samples: Sample[] = [];
  const connections: ConnectionSample[] = [];
  for (const line of data.split("\n")) {
    const process = PROCESS.exec(line);
    if (process) {
      samples.push({
        name: process[1],
        upload: Number(process[2]),
        download: Number(process[3]),
      });
      continue;
    }
    const connection = CONNECTION.exec(line);
    if (connection) {
      connections.push({
        localPort: Number(connection[1]),
        // IPv6 addresses are printed bare, e.g. 2a00:1450::e:443.
        host: connection[2],
        remotePort: Number(connection[3]),
        protocol: connection[4] as "tcp" | "udp",
        upload: Number(connection[5]),
        download: Number(connection[6]),
        process: connection[7],
      });
    }
  }
  return { samples, connections };
}
