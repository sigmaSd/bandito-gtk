import type { Limits } from "../model/settings.ts";
import type { ConnectionSample, Sample } from "../model/store.ts";

/** A program by name, or every program at once. */
export type LimitTarget = { kind: "app"; name: string } | { kind: "global" };

export interface BackendEvents {
  /** One second of traffic per process and per connection. */
  sample(samples: Sample[], connections: ConnectionSample[]): void;
  /** A program eltrafico can shape, seen even without traffic. */
  program(name: string): void;
  /** The monitor or shaper stopped unexpectedly. */
  failure(message: string): void;
}

/** Measures traffic per program and applies limits to it. */
export interface Backend {
  start(iface: string, events: BackendEvents): Promise<void>;
  switchInterface(iface: string): Promise<void>;
  setLimits(target: LimitTarget, limits: Limits): Promise<void>;
  stop(): Promise<void>;
}
