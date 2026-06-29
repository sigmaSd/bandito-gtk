export function getNetworkInterfaces(): string[] {
  const interfaces: string[] = [];
  try {
    // @ts-ignore: Deno.networkInterfaces is available in Deno
    for (const iface of Deno.networkInterfaces()) {
      if (iface.family === "IPv4" && !iface.name.startsWith("lo")) {
        if (!interfaces.includes(iface.name)) {
          interfaces.push(iface.name);
        }
      }
    }
    return interfaces.sort((a, b) => {
      const aTail = a.startsWith("tailscale");
      const bTail = b.startsWith("tailscale");
      if (aTail && !bTail) return 1;
      if (!aTail && bTail) return -1;
      return a.localeCompare(b);
    });
  } catch (e) {
    console.error("Failed to get network interfaces:", e);
    return [];
  }
}
