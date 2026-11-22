export type InterfaceKind = "wifi" | "ethernet" | "vpn" | "virtual";

export interface NetInterface {
  name: string;
  kind: InterfaceKind;
  /** "Wi‑Fi", "Ethernet", "VPN" or "Virtual". */
  label: string;
  up: boolean;
  /** Carries the default route, so it's the one in use. */
  isDefault: boolean;
}

const SYS = "/sys/class/net";

function read(path: string): string | null {
  try {
    return Deno.readTextFileSync(path).trim();
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function defaultRouteInterfaces(): Set<string> {
  const names = new Set<string>();
  const table = read("/proc/net/route");
  for (const line of table?.split("\n").slice(1) ?? []) {
    const [iface, destination] = line.trim().split(/\s+/);
    if (destination === "00000000") names.add(iface);
  }
  return names;
}

function kindOf(name: string): InterfaceKind {
  if (exists(`${SYS}/${name}/wireless`) || exists(`${SYS}/${name}/phy80211`)) {
    return "wifi";
  }
  const type = read(`${SYS}/${name}/type`);
  if (
    type === "65534" ||
    /^(tun|tap|wg|tailscale|ppp|vpn|proton|nordlynx)/.test(name)
  ) return "vpn";
  if (!exists(`${SYS}/${name}/device`)) return "virtual";
  return "ethernet";
}

const LABELS: Record<InterfaceKind, string> = {
  wifi: "Wi‑Fi",
  ethernet: "Ethernet",
  vpn: "VPN",
  virtual: "Virtual",
};

const ORDER: InterfaceKind[] = ["wifi", "ethernet", "vpn", "virtual"];

/** Network interfaces except loopback, the one in use first. */
export function listInterfaces(): NetInterface[] {
  let names: string[];
  try {
    names = [...Deno.readDirSync(SYS)].map((e) => e.name);
  } catch {
    // Sandboxes without /sys: fall back to addresses Deno can see.
    names = [...new Set(Deno.networkInterfaces().map((i) => i.name))];
  }
  const defaults = defaultRouteInterfaces();
  const list: NetInterface[] = [];
  for (const name of names) {
    if (name === "lo" || read(`${SYS}/${name}/type`) === "772") continue;
    const kind = kindOf(name);
    const state = read(`${SYS}/${name}/operstate`);
    const flags = parseInt(read(`${SYS}/${name}/flags`) ?? "0", 16);
    const up = state === "up" || (state === "unknown" && (flags & 1) === 1) ||
      state === null;
    list.push({
      name,
      kind,
      label: LABELS[kind],
      up,
      isDefault: defaults.has(name),
    });
  }
  return list.sort((a, b) =>
    Number(b.isDefault) - Number(a.isDefault) ||
    Number(b.up) - Number(a.up) ||
    ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
    a.name.localeCompare(b.name)
  );
}

/** Bytes received plus sent since the interface came up, if readable. */
export function readCounters(name: string): number | null {
  const rx = read(`${SYS}/${name}/statistics/rx_bytes`);
  const tx = read(`${SYS}/${name}/statistics/tx_bytes`);
  if (rx === null || tx === null) return null;
  return Number(rx) + Number(tx);
}

export function iconFor(kind: InterfaceKind): string {
  switch (kind) {
    case "wifi":
      return "network-wireless-symbolic";
    case "ethernet":
      return "network-wired-symbolic";
    case "vpn":
      return "network-vpn-symbolic";
    default:
      return "network-workgroup-symbolic";
  }
}
