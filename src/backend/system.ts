import { ElTrafico } from "../eltrafico/eltrafico.ts";
import { Bandwhich } from "../netmonitor/bandwhich.ts";
import type { Limits } from "../model/settings.ts";
import { toTc } from "../model/units.ts";
import type { Backend, BackendEvents, LimitTarget } from "./types.ts";

/** pkexec exits with 126 when the password prompt is dismissed. */
const AUTH_REFUSED = 126;

/** bandwhich for measuring and eltrafico-tc for shaping, both via pkexec. */
export class SystemBackend implements Backend {
  #eltrafico: ElTrafico | null = null;
  #bandwhich = new Bandwhich();
  #events: BackendEvents | null = null;
  #iface = "";
  #stopping = false;

  async start(iface: string, events: BackendEvents): Promise<void> {
    this.#events = events;
    this.#iface = iface;
    this.#stopping = false;
    const eltrafico = new ElTrafico();
    this.#eltrafico = eltrafico;
    await eltrafico.interface(iface);
    eltrafico.wait().then((status) => {
      if (this.#stopping || this.#eltrafico !== eltrafico) return;
      events.failure(
        status.code === AUTH_REFUSED
          ? "Administrator access was not granted, so limits can't be applied."
          : `The traffic shaper stopped (exit code ${status.code}).`,
      );
    });
    this.#pollPrograms(eltrafico);
    this.#startMonitor();
  }

  #startMonitor() {
    const events = this.#events!;
    this.#bandwhich.start(
      this.#iface,
      (samples, connections) => events.sample(samples, connections),
      (code) => {
        if (this.#stopping) return;
        events.failure(
          code === AUTH_REFUSED
            ? "Administrator access was not granted, so traffic can't be measured."
            : `The traffic monitor stopped (exit code ${code}).`,
        );
      },
    );
  }

  async #pollPrograms(eltrafico: ElTrafico) {
    while (!this.#stopping && this.#eltrafico === eltrafico) {
      try {
        const data = await eltrafico.poll();
        if (data.stop) break;
        for (const program of data.programs ?? []) {
          if (program.name) this.#events?.program(program.name);
        }
      } catch (e) {
        if (this.#stopping) break;
        console.error("eltrafico poll error", e);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async switchInterface(iface: string): Promise<void> {
    this.#iface = iface;
    await this.#bandwhich.stop();
    this.#bandwhich = new Bandwhich();
    await this.#eltrafico?.interface(iface);
    this.#startMonitor();
  }

  async setLimits(target: LimitTarget, limits: Limits): Promise<void> {
    if (!this.#eltrafico || this.#eltrafico.closed) {
      throw new Error("The traffic shaper isn't running.");
    }
    await this.#eltrafico.limit({
      name: target.kind === "app" ? target.name : undefined,
      global: target.kind === "global",
      downloadLimit: limits.download === null
        ? undefined
        : toTc(limits.download),
      uploadLimit: limits.upload === null ? undefined : toTc(limits.upload),
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#bandwhich.stop();
    const eltrafico = this.#eltrafico;
    this.#eltrafico = null;
    if (eltrafico && !eltrafico.closed) {
      await eltrafico.stop();
      await eltrafico.wait();
    }
  }
}
