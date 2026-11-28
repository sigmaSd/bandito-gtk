import { assertEquals } from "@std/assert";
import {
  LISTED_PROCESSES,
  PROCESS_LINGER,
  type Sample,
  Store,
} from "./store.ts";

const app = (download: number, processes?: [number, string, number][]) => ({
  name: "org.gnome.Ptyxis",
  download,
  upload: 0,
  ...processes && {
    processes: processes.map(([pid, name, rate]) => ({
      pid,
      name,
      download: rate,
      upload: 0,
    })),
  },
} satisfies Sample);

const lines = (store: Store) =>
  store.processLines(store.apps.get("org.gnome.Ptyxis")!)
    .map((l) => [l.pid, l.name, l.download]);

Deno.test("an app with one process gets no lines under it", () => {
  const store = new Store();
  store.applySample([app(1000, [[10, "ptyxis", 1000]])]);
  assertEquals(lines(store), []);
});

Deno.test("an app with several processes lists them busiest first", () => {
  const store = new Store();
  store.applySample([app(9000, [[11, "git", 1000], [10, "wget", 8000]])]);
  assertEquals(lines(store), [[10, "wget", 8000], [11, "git", 1000]]);
});

Deno.test("traffic no process accounts for is Other", () => {
  const store = new Store();
  store.applySample([app(5000, [[10, "wget", 3000]])]);
  assertEquals(lines(store), [[10, "wget", 3000], [null, "Other", 2000]]);
});

Deno.test("rounding between app and processes isn't Other", () => {
  const store = new Store();
  store.applySample([app(3002, [[10, "wget", 3000]])]);
  assertEquals(lines(store), []);
});

Deno.test("processes beyond the listed ones fold into Other", () => {
  const store = new Store();
  const many: [number, string, number][] = [];
  for (let i = 0; i <= LISTED_PROCESSES; i++) many.push([i, `p${i}`, 100 + i]);
  store.applySample([app(many.reduce((s, p) => s + p[2], 0), many)]);
  const shown = lines(store);
  assertEquals(shown.length, LISTED_PROCESSES + 1);
  assertEquals(shown.at(-1), [null, "Other", 100]);
});

Deno.test("a quiet process lingers in the list, then only in the panel", () => {
  const store = new Store();
  store.applySample([app(2000, [[10, "wget", 1000], [11, "git", 1000]])]);
  for (let i = 0; i < PROCESS_LINGER - 1; i++) {
    store.applySample([app(1000, [[10, "wget", 1000]])]);
  }
  assertEquals(lines(store), [[10, "wget", 1000], [11, "git", 0]]);
  store.applySample([app(1000, [[10, "wget", 1000]])]);
  assertEquals(lines(store), []);
  const entry = store.apps.get("org.gnome.Ptyxis")!;
  assertEquals(
    store.recentProcesses(entry).map((p) => [p.pid, p.quietFor]),
    [[10, 0], [11, PROCESS_LINGER]],
  );
});

Deno.test("without process data nothing is listed", () => {
  const store = new Store();
  store.applySample([app(5000)]);
  const entry = store.apps.get("org.gnome.Ptyxis")!;
  assertEquals(entry.hasProcesses, false);
  assertEquals(lines(store), []);
});

Deno.test("samples for the same app merge their processes", () => {
  const store = new Store();
  store.applySample([
    app(1000, [[10, "wget", 1000]]),
    app(500, [[10, "wget", 200], [11, "git", 300]]),
  ]);
  assertEquals(lines(store), [[10, "wget", 1200], [11, "git", 300]]);
});
