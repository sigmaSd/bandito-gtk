export function getNetworkInterfaces(): string[] {
  const interfaces: string[] = [];
  try {
    // @ts-ignore: Deno.networkInterfaces is available in Deno
    for (const iface of Deno.networkInterfaces()) {
      if (iface.family === "IPv4" && !iface.name.startsWith("lo")) {
        // Just get unique names
        if (!interfaces.includes(iface.name)) {
          interfaces.push(iface.name);
        }
      }
    }
    // Sort interfaces for better UX
    return interfaces.sort();
  } catch (e) {
    console.error("Failed to get network interfaces:", e);
    return [];
  }
}
