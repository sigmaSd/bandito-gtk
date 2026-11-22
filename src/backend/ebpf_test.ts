import { assertEquals } from "@std/assert";
import { convert } from "./ebpf.ts";

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

Deno.test("no unidentified sample when apps account for everything", () => {
  const { samples } = convert({
    interface: "wlan0",
    total: { rx: 100, tx: 10 },
    apps: [{ id: "steam", kind: "app", rx: 120, tx: 10 }],
    connections: [],
  });
  assertEquals(samples.map((s) => s.name), ["steam"]);
});
