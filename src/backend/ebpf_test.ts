import { assertEquals } from "@std/assert";
import { chooseNetleash, convert } from "./ebpf.ts";

Deno.test("helper samples become app, unidentified and connection samples", () => {
  const { samples, connections } = convert({
    interface: "wlan0",
    total: { rx: 1500, tx: 300 },
    apps: [
      { id: "org.mozilla.firefox", kind: "app", rx: 1000, tx: 200 },
      { id: "NetworkManager", kind: "service", rx: 100, tx: 50 },
    ],
    connections: [
      {
        app: "org.mozilla.firefox",
        protocol: "tcp",
        remote: "2606:4700::1",
        host: "example.com",
        remotePort: 443,
        localPort: 51000,
        rx: 1000,
        tx: 200,
      },
      {
        app: "NetworkManager",
        protocol: "icmp",
        remote: "192.168.1.1",
        host: null,
        remotePort: 0,
        localPort: 0,
        rx: 1,
        tx: 1,
      },
    ],
  });
  assertEquals(samples, [
    { name: "org.mozilla.firefox", download: 1000, upload: 200 },
    { name: "NetworkManager", download: 100, upload: 50 },
    { name: "<UNKNOWN>", download: 400, upload: 50 },
  ]);
  assertEquals(connections, [{
    process: "org.mozilla.firefox",
    protocol: "tcp",
    host: "example.com",
    remotePort: 443,
    localPort: 51000,
    download: 1000,
    upload: 200,
  }]);
});

Deno.test("per-process traffic, from netleash after 0.2.1, is kept", () => {
  const { samples } = convert({
    interface: "wlan0",
    total: { rx: 100, tx: 10 },
    apps: [{
      id: "org.gnome.Ptyxis",
      kind: "app",
      rx: 100,
      tx: 10,
      processTraffic: [{ pid: 52107, name: "wget", rx: 90, tx: 10 }],
    }],
    connections: [],
  });
  assertEquals(samples, [{
    name: "org.gnome.Ptyxis",
    download: 100,
    upload: 10,
    processes: [{ pid: 52107, name: "wget", download: 90, upload: 10 }],
  }]);
});

Deno.test("exited processes are passed on, and none from older netleash", () => {
  const sample = {
    interface: "wlan0",
    total: { rx: 0, tx: 0 },
    apps: [],
    connections: [],
  };
  assertEquals(convert({ ...sample, exitedProcesses: [4100] }).exited, [4100]);
  assertEquals(convert(sample).exited, []);
});

Deno.test("no unidentified sample when apps account for everything", () => {
  const { samples } = convert({
    interface: "wlan0",
    total: { rx: 100, tx: 10 },
    apps: [{ id: "steam", kind: "app", rx: 120, tx: 10 }],
    connections: [],
  });
  assertEquals(samples.map((s) => s.name), ["steam"]);
});

const plan = (overrides: Partial<Parameters<typeof chooseNetleash>[0]>) =>
  chooseNetleash({
    path: null,
    capable: () => false,
    flatpak: false,
    ...overrides,
  });

Deno.test("a netleash with its capabilities runs as the user", () => {
  assertEquals(
    plan({ path: "/home/u/.cargo/bin/netleash", capable: () => true }),
    { kind: "capable", command: ["/home/u/.cargo/bin/netleash"] },
  );
  assertEquals(
    plan({ path: "/usr/bin/netleash", capable: () => true, flatpak: true }),
    {
      kind: "capable",
      command: ["flatpak-spawn", "--host", "/usr/bin/netleash"],
    },
  );
});

Deno.test("a netleash without capabilities on the PATH is never run as root", () => {
  // It may be user-writable (~/.cargo/bin): use the checked download instead.
  assertEquals(plan({ path: "/home/u/.cargo/bin/netleash" }), {
    kind: "pinned",
  });
});

Deno.test("NETLEASH overrides, through pkexec without capabilities", () => {
  assertEquals(plan({ env: "/tmp/netleash" }), {
    kind: "override",
    command: ["pkexec", "/tmp/netleash"],
  });
  assertEquals(plan({ env: "/tmp/netleash", capable: () => true }), {
    kind: "capable",
    command: ["/tmp/netleash"],
  });
});

Deno.test("otherwise the pinned download is used, in the Flatpak too", () => {
  assertEquals(plan({}), { kind: "pinned" });
  assertEquals(plan({ flatpak: true }), { kind: "pinned" });
});
