import { parse } from "./bandwhich.ts";

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

const OUTPUT = `Refreshing:
process: <1732262400> "firefox" up/down Bps: 120/4500 connections: 3
process: <1732262400> "<UNKNOWN>" up/down Bps: 10/200 connections: 1
process: <1732262400> "Web Content" up/down Bps: 1/2 connections: 1
connection: <1732262400> <wlp3s0>:51234 => lhr25s34-in-f14.1e100.net:443 (tcp) up/down Bps: 100/4000 process: "firefox"
connection: <1732262400> <wlp3s0>:5353 => 2a00:1450:4009:81e::200e:443 (udp) up/down Bps: 10/200 process: "<UNKNOWN>"
remote_address: <1732262400> 1.1.1.1 up/down Bps: 1/2 connections: 1`;

Deno.test("parses processes, including names with spaces", () => {
  const { samples } = parse(OUTPUT);
  assertEquals(samples, [
    { name: "firefox", upload: 120, download: 4500 },
    { name: "<UNKNOWN>", upload: 10, download: 200 },
    { name: "Web Content", upload: 1, download: 2 },
  ]);
});

Deno.test("parses connections with host names and IPv6 addresses", () => {
  const { connections } = parse(OUTPUT);
  assertEquals(connections, [
    {
      localPort: 51234,
      host: "lhr25s34-in-f14.1e100.net",
      remotePort: 443,
      protocol: "tcp",
      upload: 100,
      download: 4000,
      process: "firefox",
    },
    {
      localPort: 5353,
      host: "2a00:1450:4009:81e::200e",
      remotePort: 443,
      protocol: "udp",
      upload: 10,
      download: 200,
      process: "<UNKNOWN>",
    },
  ]);
});

Deno.test("ignores address summaries and empty refreshes", () => {
  assertEquals(parse("Refreshing:\n<NO TRAFFIC>\n"), {
    samples: [],
    connections: [],
  });
});
