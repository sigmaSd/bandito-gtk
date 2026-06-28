import {
  Align,
  Application,
  ApplicationWindow,
  Box,
  Button,
  CssProvider,
  Display,
  DropDown,
  Entry,
  HeaderBar,
  Label,
  ListBox,
  Orientation,
  ProgressBar,
  ScrolledWindow,
  SizeGroup,
  SizeGroupMode,
  StringList,
  StyleContext,
  StyleProviderPriority,
  Switch,
} from "@sigmasd/gtk/gtk4";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import { ElTrafico } from "./eltrafico/eltrafico.ts";
import { bandwhich } from "./netmonitor/bandwhich.ts";
import { format } from "@std/fmt/bytes";
import { Unit } from "./interfaces/table.ts";
import {
  checkMissingBinaries,
  ensureBinaries,
} from "./utils/binary_manager.ts";
import { getNetworkInterfaces } from "./utils/network_interfaces.ts";

let userInterface = Deno.args[0];

let eltrafico: ElTrafico;
let listBox: ListBox;
const appsMap = new Map<string, AppRow>();

// SizeGroups for perfect column alignment
const sgName = new SizeGroup(SizeGroupMode.HORIZONTAL);
const sgDlRate = new SizeGroup(SizeGroupMode.HORIZONTAL);
const sgUlRate = new SizeGroup(SizeGroupMode.HORIZONTAL);
const sgDlLimit = new SizeGroup(SizeGroupMode.HORIZONTAL);
const sgUlLimit = new SizeGroup(SizeGroupMode.HORIZONTAL);
const sgActive = new SizeGroup(SizeGroupMode.HORIZONTAL);

class AppRow {
  box: Box;
  nameLabel: Label;
  dlRateLabel: Label;
  ulRateLabel: Label;
  dlLimitEntry: Entry;
  dlLimitUnit: DropDown;
  ulLimitEntry: Entry;
  ulLimitUnit: DropDown;
  activeSwitch: Switch;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(public name: string, public isGlobal: boolean = false) {
    this.box = new Box(Orientation.HORIZONTAL, 10);
    this.box.setMarginTop(2);
    this.box.setMarginBottom(2);
    this.box.setMarginStart(12);
    this.box.setMarginEnd(12);
    this.box.addCssClass("app-row");
    if (isGlobal) {
      this.box.addCssClass("global-row");
    }

    this.nameLabel = new Label(isGlobal ? "GLOBAL" : name);
    this.nameLabel.setHalign(Align.START);
    this.nameLabel.setSizeRequest(280, -1);
    this.nameLabel.setEllipsize(3); // PANGO_ELLIPSIZE_END
    this.nameLabel.addCssClass("app-name");
    sgName.addWidget(this.nameLabel);
    this.box.append(this.nameLabel);

    this.dlRateLabel = new Label("__");
    this.dlRateLabel.setXalign(1.0);
    this.dlRateLabel.setSizeRequest(120, -1);
    this.dlRateLabel.setEllipsize(3);
    this.dlRateLabel.addCssClass("rate-label");
    this.dlRateLabel.addCssClass("dl-rate");
    sgDlRate.addWidget(this.dlRateLabel);
    this.box.append(this.dlRateLabel);

    this.ulRateLabel = new Label("__");
    this.ulRateLabel.setXalign(1.0);
    this.ulRateLabel.setSizeRequest(120, -1);
    this.ulRateLabel.setEllipsize(3);
    this.ulRateLabel.addCssClass("rate-label");
    this.ulRateLabel.addCssClass("ul-rate");
    this.ulRateLabel.setMarginEnd(15); // Extra space before limits
    sgUlRate.addWidget(this.ulRateLabel);
    this.box.append(this.ulRateLabel);

    const dlLimitBox = new Box(Orientation.HORIZONTAL, 0);
    dlLimitBox.addCssClass("limit-box");
    dlLimitBox.setSizeRequest(140, -1);
    this.dlLimitEntry = new Entry();
    this.dlLimitEntry.setText("100");
    this.dlLimitEntry.addCssClass("limit-entry");
    this.dlLimitEntry.setHexpand(true);
    dlLimitBox.append(this.dlLimitEntry);

    const unitsDl = new StringList();
    ["bps", "kbps", "mbps"].forEach((u) => unitsDl.append(u));
    this.dlLimitUnit = new DropDown(unitsDl);
    this.dlLimitUnit.setSelected(1); // kbps
    this.dlLimitUnit.addCssClass("limit-unit");
    dlLimitBox.append(this.dlLimitUnit);
    sgDlLimit.addWidget(dlLimitBox);
    this.box.append(dlLimitBox);

    const ulLimitBox = new Box(Orientation.HORIZONTAL, 0);
    ulLimitBox.addCssClass("limit-box");
    ulLimitBox.setSizeRequest(140, -1);
    this.ulLimitEntry = new Entry();
    this.ulLimitEntry.setText("100");
    this.ulLimitEntry.addCssClass("limit-entry");
    this.ulLimitEntry.setHexpand(true);
    ulLimitBox.append(this.ulLimitEntry);

    const unitsUl = new StringList();
    ["bps", "kbps", "mbps"].forEach((u) => unitsUl.append(u));
    this.ulLimitUnit = new DropDown(unitsUl);
    this.ulLimitUnit.setSelected(1); // kbps
    this.ulLimitUnit.addCssClass("limit-unit");
    ulLimitBox.append(this.ulLimitUnit);
    sgUlLimit.addWidget(ulLimitBox);
    this.box.append(ulLimitBox);

    this.activeSwitch = new Switch();
    this.activeSwitch.setValign(Align.CENTER);
    this.activeSwitch.setHalign(Align.CENTER);
    sgActive.addWidget(this.activeSwitch);
    this.box.append(this.activeSwitch);

    this.activeSwitch.onActivate(() => this.updateLimitDebounced());
    this.dlLimitEntry.onChanged(() => {
      if (this.activeSwitch.getActive()) this.updateLimitDebounced();
    });
    this.ulLimitEntry.onChanged(() => {
      if (this.activeSwitch.getActive()) this.updateLimitDebounced();
    });
    this.dlLimitUnit.onSelectedChanged(() => {
      if (this.activeSwitch.getActive()) this.updateLimitDebounced();
    });
    this.ulLimitUnit.onSelectedChanged(() => {
      if (this.activeSwitch.getActive()) this.updateLimitDebounced();
    });
  }

  updateLimitDebounced() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.updateLimit();
      this.debounceTimer = null;
    }, 300);
  }

  updateLimit() {
    const active = this.activeSwitch.getActive();
    const dlValue = Number.parseFloat(this.dlLimitEntry.getText());
    const dlUnit = ["bps", "kbps", "mbps"][
      this.dlLimitUnit.getSelected()
    ] as Unit;
    const ulValue = Number.parseFloat(this.ulLimitEntry.getText());
    const ulUnit = ["bps", "kbps", "mbps"][
      this.ulLimitUnit.getSelected()
    ] as Unit;

    const app = {
      name: this.name,
      global: this.isGlobal,
      downloadLimit: active ? { value: dlValue, unit: dlUnit } : undefined,
      uploadLimit: active ? { value: ulValue, unit: ulUnit } : undefined,
    };

    eltrafico.limit(app);
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
    appRow = new AppRow(name, isGlobal);
    appsMap.set(name, appRow);
    if (isGlobal) {
      listBox.prepend(appRow.box);
    } else {
      listBox.append(appRow.box);
    }
  }
  return appRow;
}

const CSS = `
  .app-name { font-size: 1.1rem; font-weight: bold; padding-left: 5px; }
  .rate-label { font-family: monospace; font-size: 1.15rem; font-weight: 700; }
  .dl-rate { color: #2ecc71; }
  .ul-rate { color: #3498db; }
  .header-label { font-size: 0.85rem; font-weight: bold; color: #7f8c8d; }
  .global-row { background-color: rgba(241, 196, 15, 0.15); border-radius: 8px; }
  .app-row { padding: 6px 0; }
  list { background-color: transparent; margin: 10px; border-radius: 12px; border: 1px solid rgba(0,0,0,0.1); }
  row { border-bottom: 1px solid rgba(0,0,0,0.05); }
  row:last-child { border-bottom: none; }
  .main-container { background-color: @window_bg_color; }
  .header-box { padding: 10px 22px; background-color: @headerbar_bg_color; border-bottom: 1px solid @headerbar_border_color; }

  .limit-box { border: 1px solid rgba(0,0,0,0.15); border-radius: 6px; background: @window_bg_color; }
  .limit-entry { border: none; background: transparent; box-shadow: none; min-height: 30px; }
  .limit-unit { border: none; background: rgba(0,0,0,0.05); border-left: 1px solid rgba(0,0,0,0.1); border-radius: 0; }
`;

const app = new Application("com.sigmasd.bandito", 0);

app.onActivate(() => {
  const display = Display.getDefault();
  if (display) {
    const provider = new CssProvider();
    provider.loadFromData(CSS);
    StyleContext.addProviderForDisplay(
      display,
      provider,
      StyleProviderPriority.APPLICATION,
    );
  }

  const window = new ApplicationWindow(app);
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
      userInterface = interfaces[dropDown.getSelected()];
      startAppFlow(window);
    });
    box.append(button);

    window.setChild(box);
    window.present();
  } else {
    startAppFlow(window);
  }
});

async function startAppFlow(window: ApplicationWindow) {
  const missing = await checkMissingBinaries();

  if (missing) {
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

    const label = new Label("Missing dependencies. Downloading...");
    label.setHalign(Align.CENTER);
    box.append(label);

    const progressBar = new ProgressBar();
    progressBar.setShowText(true);
    progressBar.setHexpand(true);
    box.append(progressBar);

    window.setChild(box);

    // Allow UI update
    await new Promise((r) => setTimeout(r, 100));

    const errors = await ensureBinaries((status, fraction) => {
      label.setText(status);
      progressBar.setFraction(fraction);
    });

    if (errors.length > 0) {
      showErrorUI(errors);
      return;
    }

    buildMainUI(window);
  } else {
    buildMainUI(window);
  }
}

async function buildMainUI(window: ApplicationWindow) {
  eltrafico = new ElTrafico();
  await eltrafico.interface(userInterface);

  const mainBox = new Box(Orientation.VERTICAL, 0);
  mainBox.addCssClass("main-container");

  // Header Row
  const headerBox = new Box(Orientation.HORIZONTAL, 10);
  headerBox.addCssClass("header-box");
  headerBox.setHexpand(true);

  const labels = [
    { text: "NAME", align: Align.START, sg: sgName, width: 280 },
    { text: "DL RATE", xalign: 1.0, sg: sgDlRate, width: 120 },
    { text: "UL RATE", xalign: 1.0, sg: sgUlRate, width: 120, marginEnd: 15 },
    { text: "DL LIMIT", sg: sgDlLimit, width: 140 },
    { text: "UL LIMIT", sg: sgUlLimit, width: 140 },
    { text: "ACTIVE", xalign: 0.5, sg: sgActive, width: 60 },
  ];

  for (const l of labels) {
    const label = new Label(l.text);
    label.addCssClass("header-label");
    if (l.align) label.setHalign(l.align);
    if (l.xalign !== undefined) label.setXalign(l.xalign);
    if (l.width) {
      label.setSizeRequest(l.width, -1);
      label.setEllipsize(3);
    }
    if (l.marginEnd) {
      label.setMarginEnd(l.marginEnd);
    }
    if (l.sg) l.sg.addWidget(label);
    headerBox.append(label);
  }
  mainBox.append(headerBox);

  listBox = new ListBox();
  listBox.setSelectionMode(0); // NONE

  const scrolled = new ScrolledWindow();
  scrolled.setVexpand(true);
  scrolled.setMinContentHeight(400);
  scrolled.setChild(listBox);
  mainBox.append(scrolled);

  window.setChild(mainBox);
  window.present();

  window.onCloseRequest(() => {
    (async () => {
      try {
        if (eltrafico) {
          // Tell the loop to stop polling
          const stopPromise = eltrafico.stop();
          const timeoutPromise = new Promise((r) =>
            setTimeout(() => r("timeout"), 5000)
          );
          const result = await Promise.race([stopPromise, timeoutPromise]);
          if (result === "timeout") {
            console.log("Forcing eltrafico kill...");
            eltrafico.kill();
          }
          // Wait for process to actually exit
          await eltrafico.wait();
        }
      } catch (e) {
        console.error("Error during shutdown:", e);
      } finally {
        Deno.exit(0);
      }
    })();
    return false;
  });
  // Start discovery loop (eltrafico)
  (async () => {
    while (true) {
      try {
        const data = await eltrafico.poll();
        if (data.stop) break;
        if (!data.programs) continue;
        for (const app of data.programs) {
          ensureAppRow(app.name);
        }
      } catch (e) {
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
        let totalDl = 0;
        let totalUl = 0;
        for (const app of apps) {
          totalDl += app.downloadRate;
          totalUl += app.uploadRate;
          const row = ensureAppRow(app.name);
          row.updateRates(app.downloadRate, app.uploadRate);
        }
        const globalRow = ensureAppRow("[INTERNAL]GLOBAL", true);
        globalRow.updateRates(totalDl, totalUl);
      }
    } catch (e) {
      console.error("bandwhich error", e);
    }
  })();
}

const eventLoop = new EventLoop();
await eventLoop.start(app);
