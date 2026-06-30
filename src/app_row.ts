import {
  Align,
  Box,
  CheckButton,
  Entry,
  GestureClick,
  Grid,
  Label,
  Orientation,
  Popover,
} from "@sigmasd/gtk/gtk4";
import { format } from "@std/fmt/bytes";
import { type ElTrafico } from "./eltrafico/eltrafico.ts";
import type { Unit } from "./types.ts";

export class AppRow {
  nameLabel: Label;
  dlRateLabel: Label;
  ulRateLabel: Label;
  dlLimitDisplay: Label;
  ulLimitDisplay: Label;
  dlLimitEntry: Entry;
  ulLimitEntry: Entry;
  checkButton: CheckButton;
  dlPopover: Popover;
  ulPopover: Popover;
  #eltrafico: ElTrafico;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    grid: Grid,
    row: number,
    eltrafico: ElTrafico,
    public name: string,
    public isGlobal: boolean = false,
  ) {
    this.#eltrafico = eltrafico;

    const rowClass = isGlobal
      ? "global-row"
      : (row % 2 === 0 ? "app-row-even" : "app-row-odd");

    this.nameLabel = new Label(isGlobal ? "GLOBAL" : name);
    this.nameLabel.setHalign(Align.START);
    this.nameLabel.setHexpand(true);
    this.nameLabel.setEllipsize(3);
    this.nameLabel.addCssClass(isGlobal ? "global-cell" : "app-cell");
    if (!isGlobal) this.nameLabel.addCssClass("app-name");
    this.nameLabel.addCssClass(rowClass);
    grid.attach(this.nameLabel, 0, row, 1, 1);

    this.dlRateLabel = new Label("__");
    this.dlRateLabel.setXalign(1.0);
    this.dlRateLabel.setSizeRequest(100, -1);
    this.dlRateLabel.addCssClass("rate-cell");
    this.dlRateLabel.addCssClass("dl-rate");
    this.dlRateLabel.addCssClass(rowClass);
    grid.attach(this.dlRateLabel, 1, row, 1, 1);

    this.ulRateLabel = new Label("__");
    this.ulRateLabel.setXalign(1.0);
    this.ulRateLabel.setSizeRequest(100, -1);
    this.ulRateLabel.addCssClass("rate-cell");
    this.ulRateLabel.addCssClass("ul-rate");
    this.ulRateLabel.addCssClass(rowClass);
    grid.attach(this.ulRateLabel, 2, row, 1, 1);

    this.dlLimitDisplay = new Label("100 kbps");
    this.dlLimitDisplay.addCssClass("limit-display");
    this.dlLimitDisplay.setHalign(Align.START);
    this.dlLimitDisplay.addCssClass(rowClass);

    const dlPopoverBox = new Box(Orientation.HORIZONTAL, 4);
    dlPopoverBox.setMarginTop(6);
    dlPopoverBox.setMarginBottom(6);
    dlPopoverBox.setMarginStart(8);
    dlPopoverBox.setMarginEnd(8);
    this.dlLimitEntry = new Entry();
    this.dlLimitEntry.setText("100");
    this.dlLimitEntry.setSizeRequest(50, -1);
    this.dlLimitEntry.addCssClass("limit-entry");
    dlPopoverBox.append(this.dlLimitEntry);
    const dlUnitLabel = new Label("kbps");
    dlUnitLabel.addCssClass("limit-unit");
    dlPopoverBox.append(dlUnitLabel);

    this.dlPopover = new Popover();
    this.dlPopover.setChild(dlPopoverBox);
    this.dlPopover.setParent(this.dlLimitDisplay);

    const dlClickGesture = new GestureClick();
    dlClickGesture.onReleased(() => {
      this.dlPopover.popup();
    });
    this.dlLimitDisplay.addController(dlClickGesture);

    this.dlLimitEntry.onActivate(() => {
      this.updateLimitDisplay();
      this.dlPopover.popdown();
      if (this.checkButton.getActive()) this.updateLimitDebounced();
    });

    grid.attach(this.dlLimitDisplay, 3, row, 1, 1);

    this.ulLimitDisplay = new Label("100 kbps");
    this.ulLimitDisplay.addCssClass("limit-display");
    this.ulLimitDisplay.setHalign(Align.START);
    this.ulLimitDisplay.addCssClass(rowClass);

    const ulPopoverBox = new Box(Orientation.HORIZONTAL, 4);
    ulPopoverBox.setMarginTop(6);
    ulPopoverBox.setMarginBottom(6);
    ulPopoverBox.setMarginStart(8);
    ulPopoverBox.setMarginEnd(8);
    this.ulLimitEntry = new Entry();
    this.ulLimitEntry.setText("100");
    this.ulLimitEntry.setSizeRequest(50, -1);
    this.ulLimitEntry.addCssClass("limit-entry");
    ulPopoverBox.append(this.ulLimitEntry);
    const ulUnitLabel = new Label("kbps");
    ulUnitLabel.addCssClass("limit-unit");
    ulPopoverBox.append(ulUnitLabel);

    this.ulPopover = new Popover();
    this.ulPopover.setChild(ulPopoverBox);
    this.ulPopover.setParent(this.ulLimitDisplay);

    const ulClickGesture = new GestureClick();
    ulClickGesture.onReleased(() => {
      this.ulPopover.popup();
    });
    this.ulLimitDisplay.addController(ulClickGesture);

    this.ulLimitEntry.onActivate(() => {
      this.updateLimitDisplay();
      this.ulPopover.popdown();
      if (this.checkButton.getActive()) this.updateLimitDebounced();
    });

    grid.attach(this.ulLimitDisplay, 4, row, 1, 1);

    this.checkButton = new CheckButton();
    this.checkButton.setHalign(Align.CENTER);
    this.checkButton.addCssClass("check-cell");
    this.checkButton.addCssClass(rowClass);
    this.checkButton.onToggled(() => {
      this.updateLimitDebounced();
    });
    grid.attach(this.checkButton, 5, row, 1, 1);
  }

  updateLimitDisplay() {
    const dlValue = this.dlLimitEntry.getText() || "100";
    this.dlLimitDisplay.setText(`${dlValue} kbps`);

    const ulValue = this.ulLimitEntry.getText() || "100";
    this.ulLimitDisplay.setText(`${ulValue} kbps`);
  }

  updateLimitDebounced() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.updateLimit();
      this.debounceTimer = null;
    }, 300);
  }

  updateLimit() {
    const active = this.checkButton.getActive();
    const dlValue = Number.parseFloat(this.dlLimitEntry.getText());
    const ulValue = Number.parseFloat(this.ulLimitEntry.getText());

    const app = {
      name: this.name,
      global: this.isGlobal,
      downloadLimit: active
        ? { value: dlValue, unit: "kbps" as Unit }
        : undefined,
      uploadLimit: active
        ? { value: ulValue, unit: "kbps" as Unit }
        : undefined,
    };

    this.#eltrafico.limit(app);
  }

  cleanup() {
    this.dlPopover?.unparent();
    this.ulPopover?.unparent();
  }

  updateRates(dl?: number, ul?: number) {
    if (dl !== undefined && Number.isFinite(dl)) {
      this.dlRateLabel.setText(format(dl, { binary: true }));
    }
    if (ul !== undefined && Number.isFinite(ul)) {
      this.ulRateLabel.setText(format(ul, { binary: true }));
    }
  }
}
