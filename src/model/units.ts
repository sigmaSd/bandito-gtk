/** Units understood by `tc`: bytes, kilobytes and megabytes per second. */
export type Unit = "bps" | "kbps" | "mbps";

/** Rates are kept in bytes per second everywhere in the app. */
export type Rate = number;

export interface DisplayUnit {
  label: string;
  /** Bytes per second in one of this unit. */
  bytes: number;
}

const BYTE_UNITS: DisplayUnit[] = [
  { label: "KB/s", bytes: 1000 },
  { label: "MB/s", bytes: 1000 * 1000 },
];

const BIT_UNITS: DisplayUnit[] = [
  { label: "kbit/s", bytes: 1000 / 8 },
  { label: "Mbit/s", bytes: 1000 * 1000 / 8 },
];

/** The small and large unit used for limits, in bytes or bits. */
export function limitUnits(bits: boolean): DisplayUnit[] {
  return bits ? BIT_UNITS : BYTE_UNITS;
}

/** Index into {@link limitUnits} that reads best for a value. */
export function preferredUnit(rate: Rate, bits: boolean): number {
  return rate >= limitUnits(bits)[1].bytes ? 1 : 0;
}

function trim(value: number): string {
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return (Math.round(value * 10) / 10).toString();
  return (Math.round(value * 100) / 100).toString();
}

function compact(value: number): string {
  return value < 10
    ? (Math.round(value * 10) / 10).toString()
    : Math.round(value).toString();
}

/** A rate such as "1.8 MB/s", or an em dash when there is no traffic. */
export function formatRate(rate: Rate, bits: boolean): string {
  if (!(rate >= 1)) return "—";
  if (bits) {
    const value = rate * 8;
    if (value >= 1e6) return `${compact(value / 1e6)} Mbit/s`;
    if (value >= 1e3) return `${compact(value / 1e3)} kbit/s`;
    return `${Math.round(value)} bit/s`;
  }
  if (rate >= 1e6) return `${compact(rate / 1e6)} MB/s`;
  if (rate >= 1e3) return `${compact(rate / 1e3)} KB/s`;
  return `${Math.round(rate)} B/s`;
}

/** A limit such as "2 MB/s" or "256 KB/s", keeping up to two decimals. */
export function formatLimit(rate: Rate, bits: boolean): string {
  const unit = limitUnits(bits)[preferredUnit(rate, bits)];
  return `${trim(rate / unit.bytes)} ${unit.label}`;
}
