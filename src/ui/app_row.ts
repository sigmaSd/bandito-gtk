import {
  Align,
  Box,
  DrawingArea,
  Label,
  ListBoxRow,
  Orientation,
  type SizeGroup,
} from "@sigmasd/gtk/gtk4";
import { identify, type Identity } from "../model/identity.ts";
import { APP_HISTORY, type AppEntry, hasLimit } from "../model/store.ts";
import { formatLimit, formatRate } from "../model/units.ts";
import { appIcon } from "./app_icon.ts";
import { drawSparkline, type Palette } from "./charts.ts";

export interface RowContext {
  bits(): boolean;
  colors(): Palette;
  /** Widths shared with the column headers. */
  columns: {
    spark: SizeGroup;
    download: SizeGroup;
    upload: SizeGroup;
    limit: SizeGroup;
  };
}

/** A rate this close to its limit means the app is being throttled. */
const THROTTLED = 0.9;

/** One program: icon, name, last 30 seconds, rates and its limits. */
export class AppRow extends ListBoxRow {
  readonly entry: AppEntry;
  readonly identity: Identity;
  #ctx: RowContext;
  #download: Label;
  #upload: Label;
  #spark: DrawingArea;
  #limits: Box;
  #limitKey = "";

  constructor(entry: AppEntry, ctx: RowContext) {
    super();
    this.entry = entry;
    this.identity = identify(entry.name);
    this.#ctx = ctx;
    this.addCssClass("app-row");

    const box = new Box(Orientation.HORIZONTAL, 12);
    box.setMarginTop(8);
    box.setMarginBottom(8);
    box.setMarginStart(12);
    box.setMarginEnd(12);

    box.append(appIcon(entry.name, this.identity, 32));

    const names = new Box(Orientation.VERTICAL, 0);
    names.setHexpand(true);
    names.setValign(Align.CENTER);
    const title = new Label(this.identity.title);
    title.setXalign(0);
    title.setEllipsize(3);
    title.addCssClass("app-title");
    const subtitle = new Label(this.identity.subtitle);
    subtitle.setXalign(0);
    subtitle.setEllipsize(3);
    subtitle.addCssClass("caption");
    subtitle.addCssClass("dim-label");
    names.append(title);
    names.append(subtitle);
    box.append(names);

    this.#spark = new DrawingArea();
    this.#spark.setContentWidth(92);
    this.#spark.setContentHeight(28);
    this.#spark.setValign(Align.CENTER);
    this.#spark.setDrawFunc((_area, cr, width, height) =>
      drawSparkline(
        cr,
        width,
        height,
        this.entry.history,
        APP_HISTORY,
        this.#ctx.colors(),
      )
    );
    ctx.columns.spark.addWidget(this.#spark);
    box.append(this.#spark);

    this.#download = this.#rateLabel("rate-download");
    ctx.columns.download.addWidget(this.#download);
    box.append(this.#download);
    this.#upload = this.#rateLabel("rate-upload");
    ctx.columns.upload.addWidget(this.#upload);
    box.append(this.#upload);

    this.#limits = new Box(Orientation.HORIZONTAL, 4);
    this.#limits.setHalign(Align.END);
    this.#limits.setValign(Align.CENTER);
    ctx.columns.limit.addWidget(this.#limits);
    box.append(this.#limits);

    this.setChild(box);
    this.refresh();
  }

  #rateLabel(cssClass: string): Label {
    const label = new Label("—");
    label.setXalign(1);
    label.setWidthChars(10);
    label.addCssClass("numeric");
    label.addCssClass("rate");
    label.addCssClass(cssClass);
    return label;
  }

  #setRate(label: Label, rate: number) {
    label.setText(formatRate(rate, this.#ctx.bits()));
    if (rate >= 1) label.removeCssClass("zero");
    else label.addCssClass("zero");
  }

  /** Update rates, chart and limit chips from the entry. */
  refresh(): void {
    const { entry } = this;
    this.#setRate(this.#download, entry.download);
    this.#setRate(this.#upload, entry.upload);
    this.#spark.queueDraw();

    const bits = this.#ctx.bits();
    const hotDown = entry.limits.download !== null &&
      entry.download >= entry.limits.download * THROTTLED;
    const hotUp = entry.limits.upload !== null &&
      entry.upload >= entry.limits.upload * THROTTLED;
    const key = [
      entry.limits.download,
      entry.limits.upload,
      hotDown,
      hotUp,
      bits,
    ]
      .join("|");
    if (key === this.#limitKey) return;
    this.#limitKey = key;

    let child = this.#limits.getFirstChild();
    while (child) {
      const next = this.#limits.getNextSibling(child);
      this.#limits.remove(child);
      child = next;
    }
    if (!hasLimit(entry.limits)) {
      if (this.identity.limitable) {
        const hint = new Label("Limit…");
        hint.addCssClass("limit-hint");
        this.#limits.append(hint);
      }
      return;
    }
    const chip = (arrow: string, value: number, hot: boolean) => {
      const label = new Label(`${arrow} ${formatLimit(value, bits)}`);
      label.addCssClass("limit-chip");
      label.addCssClass("numeric");
      if (hot) label.addCssClass("throttled");
      label.setTooltipText(
        hot ? "Being slowed down to its limit right now" : "Limit",
      );
      this.#limits.append(label);
    };
    if (entry.limits.download !== null) {
      chip("↓", entry.limits.download, hotDown);
    }
    if (entry.limits.upload !== null) chip("↑", entry.limits.upload, hotUp);
  }

  setIdle(idle: boolean): void {
    if (idle) this.addCssClass("idle");
    else this.removeCssClass("idle");
  }
}
