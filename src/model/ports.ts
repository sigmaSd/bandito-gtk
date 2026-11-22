/** Well-known services, to label a connection by what it is likely for. */
const SERVICES: Record<number, string> = {
  20: "FTP data",
  21: "FTP",
  22: "SSH",
  25: "Mail (SMTP)",
  53: "DNS",
  67: "DHCP",
  68: "DHCP",
  80: "Web (HTTP)",
  123: "Time sync (NTP)",
  137: "Windows sharing",
  138: "Windows sharing",
  139: "Windows sharing",
  143: "Mail (IMAP)",
  443: "Web (HTTPS)",
  445: "Windows sharing",
  465: "Mail (SMTP)",
  587: "Mail (SMTP)",
  853: "DNS over TLS",
  993: "Mail (IMAP)",
  995: "Mail (POP)",
  1194: "OpenVPN",
  1900: "Device discovery (SSDP)",
  3478: "Calls (STUN)",
  5222: "Chat (XMPP)",
  5353: "Local discovery (mDNS)",
  5355: "Local name lookup (LLMNR)",
  8080: "Web (HTTP)",
  8443: "Web (HTTPS)",
  9418: "Git",
  22000: "Syncthing",
  41641: "Tailscale",
  51820: "WireGuard",
};

/** A readable name for the service on a port, if it's a common one. */
export function serviceName(port: number): string | null {
  return SERVICES[port] ?? null;
}
