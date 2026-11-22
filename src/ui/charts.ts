import type { CairoContext } from "@sigmasd/gtk/cairo";
import { LineJoin } from "@sigmasd/gtk/cairo";
import type { Rate } from "../model/units.ts";

type RGB = [number, number, number];

export interface Palette {
  download: RGB;
  upload: RGB;
  grid: RGB;
}

const LIGHT: Palette = {
  download: [15 / 255, 123 / 255, 132 / 255],
  upload: [192 / 255, 74 / 255, 0],
  grid: [0, 0, 0],
};

const DARK: Palette = {
  download: [95 / 255, 211 / 255, 218 / 255],
  upload: [1, 161 / 255, 82 / 255],
  grid: [1, 1, 1],
};

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

/** Path through the samples, right-aligned so new data enters at the right. */
function trace(
  cr: CairoContext,
  values: number[],
  slots: number,
  width: number,
  yFor: (v: number) => number,
) {
  const step = width / Math.max(1, slots - 1);
  const offset = (slots - values.length) * step;
  values.forEach((v, i) => {
    const x = offset + i * step;
    if (i === 0) cr.moveTo(x, yFor(v));
    else cr.lineTo(x, yFor(v));
  });
  return { first: offset, last: offset + (values.length - 1) * step };
}

function area(
  cr: CairoContext,
  values: number[],
  slots: number,
  width: number,
  base: number,
  yFor: (v: number) => number,
  color: RGB,
  lineWidth: number,
  fillAlpha: number,
) {
  if (values.length < 2) return;
  cr.setLineJoin(LineJoin.ROUND);
  cr.newPath();
  const { first, last } = trace(cr, values, slots, width, yFor);
  cr.lineTo(last, base);
  cr.lineTo(first, base);
  cr.closePath();
  cr.setSourceRgba(...color, fillAlpha);
  cr.fill();
  cr.newPath();
  trace(cr, values, slots, width, yFor);
  cr.setSourceRgba(...color, 1);
  cr.setLineWidth(lineWidth);
  cr.stroke();
}

/** Small per-app chart: download and upload over the last 30 seconds. */
export function drawSparkline(
  cr: CairoContext,
  width: number,
  height: number,
  history: [Rate, Rate][],
  slots: number,
  colors: Palette,
) {
  const max = Math.max(1000, ...history.map(([d, u]) => Math.max(d, u)));
  const yFor = (v: number) => height - 2 - (v / max) * (height - 4);
  area(
    cr,
    history.map((h) => h[0]),
    slots,
    width,
    height,
    yFor,
    colors.download,
    1.5,
    0.15,
  );
  if (history.some((h) => h[1] > 0)) {
    area(
      cr,
      history.map((h) => h[1]),
      slots,
      width,
      height,
      yFor,
      colors.upload,
      1.2,
      0,
    );
  }
}

/** Top of each half of the totals chart, with a floor so quiet links stay flat. */
export function totalsScale(
  history: [Rate, Rate][],
): { maxDownload: Rate; maxUpload: Rate } {
  return {
    maxDownload: Math.max(50e3, ...history.map((h) => h[0])),
    maxUpload: Math.max(20e3, ...history.map((h) => h[1])),
  };
}

/** Mirrored chart: download above the middle line, upload below it. */
/** Height kept free above and below the totals plot for its scale labels. */
export const LABEL_BAND = 16;

export function drawTotals(
  cr: CairoContext,
  width: number,
  height: number,
  history: [Rate, Rate][],
  slots: number,
  colors: Palette,
): { maxDownload: Rate; maxUpload: Rate } {
  // Keep the plot clear of the scale labels drawn above and below it.
  const top = LABEL_BAND;
  const bottom = height - LABEL_BAND;
  const mid = top + Math.round((bottom - top) * 0.58) + 0.5;
  const { maxDownload, maxUpload } = totalsScale(history);

  cr.setSourceRgba(...colors.grid, 0.12);
  cr.setLineWidth(1);
  cr.moveTo(0, mid);
  cr.lineTo(width, mid);
  cr.stroke();

  area(
    cr,
    history.map((h) => h[0]),
    slots,
    width,
    mid - 1,
    (v) => mid - 1 - (v / maxDownload) * (mid - 1 - top),
    colors.download,
    2,
    0.18,
  );
  area(
    cr,
    history.map((h) => h[1]),
    slots,
    width,
    mid + 1,
    (v) => mid + 1 + (v / maxUpload) * (bottom - mid - 1),
    colors.upload,
    1.6,
    0.18,
  );
  return { maxDownload, maxUpload };
}
