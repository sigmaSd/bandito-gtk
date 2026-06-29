import {
  Align,
  Application,
  ApplicationWindow,
  Box,
  Button,
  CheckButton,
  CssProvider,
  Display,
  DropDown,
  Entry,
  GestureClick,
  Grid,
  HeaderBar,
  Label,
  Orientation,
  Popover,
  ProgressBar,
  ScrolledWindow,
  StringList,
  StyleContext,
  StyleProviderPriority,
} from "@sigmasd/gtk/gtk4";
import styles from "./styles.css" with { type: "text" };
import { EventLoop } from "@sigmasd/gtk/eventloop";
import { ElTrafico } from "./eltrafico/eltrafico.ts";
import { bandwhich } from "./netmonitor/bandwhich.ts";
import { format } from "@std/fmt/bytes";
import { Unit } from "./interfaces/table.ts";
import { ensureBinaries } from "./utils/binary_manager.ts";
import { getNetworkInterfaces } from "./utils/network_interfaces.ts";

let userInterface = Deno.args[0];

let eltrafico: ElTrafico;
let tableGrid: Grid;
let tableRowCount = 0;
const appsMap = new Map<string, AppRow>();

let shutdownInProgress = false;
// deno-lint-ignore prefer-const
let appRef: Application;

async function shutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  for (const appRow of appsMap.values()) {
    appRow.cleanup();
  }

  try {
    if (eltrafico) {
      await eltrafico.stop();
      const waitPromise = eltrafico.wait();
      const timeoutPromise = new Promise((r) =>
        setTimeout(() => r("timeout"), 5000)
      );
      const result = await Promise.race([waitPromise, timeoutPromise]);
      if (result === "timeout") {
        eltrafico.kill();
        await eltrafico.wait().catch(() => {});
      }
    }
  } catch {
    // ignore
  }
  eventLoop.stop();
}

Deno.addSignalListener("SIGINT", () => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  for (const appRow of appsMap.values()) {
    appRow.cleanup();
  }

  if (eltrafico) {
    eltrafico.stop().catch(() => {});
  }
  setTimeout(() => eventLoop.stop(), 1000);
});

class AppRow {
  grid: Grid;
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
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    public name: string,
    public isGlobal: boolean = false,
    private rowIndex: number = 0,
  ) {
    this.grid = new Grid();
    this.grid.setColumnSpacing(0);
    this.grid.setRowSpacing(0);

    const rowClass = isGlobal
      ? "global-row"
      : (rowIndex % 2 === 0 ? "app-row-even" : "app-row-odd");
    this.grid.addCssClass(rowClass);

    // Column 0: App name
    this.nameLabel = new Label(isGlobal ? "GLOBAL" : name);
    this.nameLabel.setHalign(Align.START);
    this.nameLabel.setHexpand(true);
    this.nameLabel.setEllipsize(3);
    this.nameLabel.addCssClass(isGlobal ? "global-cell" : "app-cell");
    if (!isGlobal) this.nameLabel.addCssClass("app-name");
    this.grid.attach(this.nameLabel, 0, 0, 1, 1);

    // Column 1: DL rate
    this.dlRateLabel = new Label("__");
    this.dlRateLabel.setXalign(1.0);
    this.dlRateLabel.setSizeRequest(100, -1);
    this.dlRateLabel.addCssClass("rate-cell");
    this.dlRateLabel.addCssClass("dl-rate");
    this.grid.attach(this.dlRateLabel, 1, 0, 1, 1);

    // Column 2: UL rate
    this.ulRateLabel = new Label("__");
    this.ulRateLabel.setXalign(1.0);
    this.ulRateLabel.setSizeRequest(100, -1);
    this.ulRateLabel.addCssClass("rate-cell");
    this.ulRateLabel.addCssClass("ul-rate");
    this.grid.attach(this.ulRateLabel, 2, 0, 1, 1);

    // Column 3: DL limit — display label with popover editor
    this.dlLimitDisplay = new Label("100 kbps");
    this.dlLimitDisplay.addCssClass("limit-display");
    this.dlLimitDisplay.setHalign(Align.START);

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

    this.grid.attach(this.dlLimitDisplay, 3, 0, 1, 1);

    // Column 4: UL limit
    this.ulLimitDisplay = new Label("100 kbps");
    this.ulLimitDisplay.addCssClass("limit-display");
    this.ulLimitDisplay.setHalign(Align.START);

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

    this.grid.attach(this.ulLimitDisplay, 4, 0, 1, 1);

    // Column 5: Active checkbox
    this.checkButton = new CheckButton();
    this.checkButton.setHalign(Align.CENTER);
    this.checkButton.addCssClass("check-cell");
    this.checkButton.onToggled(() => {
      this.updateLimitDebounced();
    });
    this.grid.attach(this.checkButton, 5, 0, 1, 1);
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

    eltrafico.limit(app);
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

function ensureAppRow(name: string, isGlobal = false) {
  let appRow = appsMap.get(name);
  if (!appRow) {
    const rowIndex = isGlobal ? 1 : appsMap.size + 1;
    appRow = new AppRow(name, isGlobal, rowIndex);
    appsMap.set(name, appRow);
    if (isGlobal) {
      tableGrid.attach(appRow.grid, 0, 1, 6, 1);
    } else {
      const row = tableRowCount;
      tableGrid.attach(appRow.grid, 0, row, 6, 1);
      tableRowCount++;
    }
  }
  return appRow;
}

appRef = new Application("com.sigmasd.bandito", 0);

appRef.onActivate(() => {
  const display = Display.getDefault();
  if (display) {
    const provider = new CssProvider();
    provider.loadFromData(styles);
    StyleContext.addProviderForDisplay(
      display,
      provider,
      StyleProviderPriority.APPLICATION,
    );
  }

  const window = new ApplicationWindow(appRef);
  window.setTitle("Bandito GTK");
  window.setDefaultSize(950, 700);

  const header = new HeaderBar();
  window.setTitlebar(header);

  if (!userInterface) {
    const interfaces = getNetworkInterfaces();
    if (interfaces.length === 0) {
      console.error("No network interfaces found.");
      Deno.exit(1);
    }

    // If only one interface (excluding lo), just use it?
    // Maybe better to always show selection for clarity unless force via CLI.

    const box = new Box(Orientation.VERTICAL, 20);
    box.setMarginTop(50);
    box.setMarginBottom(50);
    box.setMarginStart(50);
    box.setMarginEnd(50);
    box.setValign(Align.CENTER);
    box.setHalign(Align.CENTER);

    const label = new Label("Select Network Interface");
    box.append(label);

    const stringList = new StringList();
    interfaces.forEach((i) => stringList.append(i));
    const dropDown = new DropDown(stringList);
    dropDown.setSelected(0);
    box.append(dropDown);

    const button = new Button("Start");
    button.onClick(() => {
      button.setSensitive(false);
      userInterface = interfaces[dropDown.getSelected()];
      startAppFlow(window);
    });
    box.append(button);

    window.setChild(box);
    window.present();
    dropDown.grabFocus();
  } else {
    startAppFlow(window);
  }
});

async function startAppFlow(window: ApplicationWindow) {
  const showErrorUI = (errors: string[]) => {
    const box = new Box(Orientation.VERTICAL, 20);
    box.setMarginTop(50);
    box.setMarginBottom(50);
    box.setMarginStart(50);
    box.setMarginEnd(50);
    box.setValign(Align.CENTER);

    const label = new Label("Failed to install required dependencies:");
    label.setHalign(Align.CENTER);
    box.append(label);

    const errorLabel = new Label(errors.join("\n"));
    errorLabel.setHalign(Align.CENTER);
    errorLabel.setWrap(true);
    box.append(errorLabel);

    const retryBtn = new Button("Retry");
    retryBtn.setHalign(Align.CENTER);
    retryBtn.onClick(() => {
      startAppFlow(window);
    });
    box.append(retryBtn);

    window.setChild(box);
  };

  const box = new Box(Orientation.VERTICAL, 20);
  box.setMarginTop(50);
  box.setMarginBottom(50);
  box.setMarginStart(50);
  box.setMarginEnd(50);
  box.setValign(Align.CENTER);

  const label = new Label("Checking for updates...");
  label.setHalign(Align.CENTER);
  box.append(label);

  const progressBar = new ProgressBar();
  progressBar.setShowText(true);
  progressBar.setHexpand(true);
  progressBar.setVisible(false);
  box.append(progressBar);

  window.setChild(box);

  await new Promise((r) => setTimeout(r, 50));

  const errors = await ensureBinaries((status, fraction) => {
    label.setText(status);
    if (fraction > 0) {
      progressBar.setVisible(true);
      progressBar.setFraction(fraction);
    }
  });

  progressBar.setVisible(false);

  if (errors.length > 0) {
    showErrorUI(errors);
    return;
  }

  buildMainUI(window);
}

async function buildMainUI(window: ApplicationWindow) {
  eltrafico = new ElTrafico();
  await eltrafico.interface(userInterface);

  const mainBox = new Box(Orientation.VERTICAL, 0);
  mainBox.addCssClass("main-container");
  mainBox.setHexpand(true);

  // Single Grid for header + data rows
  tableGrid = new Grid();
  tableGrid.setColumnSpacing(0);
  tableGrid.setRowSpacing(0);
  tableGrid.addCssClass("table-grid");
  tableGrid.setHexpand(true);

  // Header Row (row 0)
  const headerLabels = [
    { text: "APP", col: 0, expand: true, align: Align.START },
    { text: "DL", col: 1, width: 100, align: Align.END },
    { text: "UL", col: 2, width: 100, align: Align.END },
    { text: "DL LIMIT", col: 3, width: 100, align: Align.START },
    { text: "UL LIMIT", col: 4, width: 100, align: Align.START },
    { text: "ON", col: 5, width: 40, align: Align.CENTER },
  ];

  for (const h of headerLabels) {
    const label = new Label(h.text);
    label.addCssClass("header-cell");
    label.setHalign(h.align);
    if (h.width) label.setSizeRequest(h.width, -1);
    if (h.expand) label.setHexpand(true);
    tableGrid.attach(label, h.col, 0, 1, 1);
  }

  tableRowCount = 2; // row 0 = header, row 1 = GLOBAL

  const scrolled = new ScrolledWindow();
  scrolled.setVexpand(true);
  scrolled.setHexpand(true);
  scrolled.setMinContentHeight(400);
  scrolled.setChild(tableGrid);
  mainBox.append(scrolled);

  window.setChild(mainBox);
  window.present();

  window.onCloseRequest(() => {
    shutdown();
    return false;
  });
  // Start discovery loop (eltrafico)
  (async () => {
    while (!shutdownInProgress) {
      try {
        const data = await eltrafico.poll();
        if (data.stop || shutdownInProgress) break;
        if (!data.programs) continue;
        for (const app of data.programs) {
          if (shutdownInProgress) break;
          ensureAppRow(app.name);
        }
      } catch (e) {
        if (shutdownInProgress) break;
        console.error("eltrafico poll error", e);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();

  // Start monitoring loop (bandwhich)
  (async () => {
    try {
      const netState = bandwhich(userInterface);
      for await (const apps of netState) {
        if (shutdownInProgress) break;
        let totalDl = 0;
        let totalUl = 0;
        for (const app of apps) {
          if (shutdownInProgress) break;
          totalDl += app.downloadRate;
          totalUl += app.uploadRate;
          const row = ensureAppRow(app.name);
          row.updateRates(app.downloadRate, app.uploadRate);
        }
        if (shutdownInProgress) break;
        const globalRow = ensureAppRow("[INTERNAL]GLOBAL", true);
        globalRow.updateRates(totalDl, totalUl);
      }
    } catch (e) {
      if (!shutdownInProgress) console.error("bandwhich error", e);
    }
  })();
}

const eventLoop = new EventLoop();
await eventLoop.start(appRef);
