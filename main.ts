import {
  Align,
  Application,
  ApplicationWindow,
  Box,
  Button,
  CheckButton,
  DropDown,
  Entry,
  Label,
  ListBox,
  Orientation,
  ProgressBar,
  ScrolledWindow,
  StringList,
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

class AppRow {
  box: Box;
  nameLabel: Label;
  dlRateLabel: Label;
  ulRateLabel: Label;
  dlLimitEntry: Entry;
  dlLimitUnit: DropDown;
  ulLimitEntry: Entry;
  ulLimitUnit: DropDown;
  activeCheck: CheckButton;

  constructor(public name: string, public isGlobal: boolean = false) {
    this.box = new Box(Orientation.HORIZONTAL, 10);
    this.box.setMarginTop(5);
    this.box.setMarginBottom(5);
    this.box.setMarginStart(10);
    this.box.setMarginEnd(10);

    this.nameLabel = new Label(isGlobal ? "Global" : name);
    this.nameLabel.setHalign(Align.START);
    this.nameLabel.setSizeRequest(200, -1);
    this.nameLabel.setEllipsize(3); // PANGO_ELLIPSIZE_END
    this.box.append(this.nameLabel);

    this.dlRateLabel = new Label("__");
    this.dlRateLabel.setSizeRequest(100, -1);
    this.dlRateLabel.setXalign(0.5);
    this.box.append(this.dlRateLabel);

    this.ulRateLabel = new Label("__");
    this.ulRateLabel.setSizeRequest(100, -1);
    this.ulRateLabel.setXalign(0.5);
    this.box.append(this.ulRateLabel);

    const dlLimitBox = new Box(Orientation.HORIZONTAL, 2);
    dlLimitBox.setSizeRequest(120, -1);
    this.dlLimitEntry = new Entry();
    this.dlLimitEntry.setText("450");
    this.dlLimitEntry.setHexpand(true);
    dlLimitBox.append(this.dlLimitEntry);

    const unitsDl = new StringList();
    ["bps", "kbps", "mbps"].forEach((u) => unitsDl.append(u));
    this.dlLimitUnit = new DropDown(unitsDl);
    this.dlLimitUnit.setSelected(1); // kbps
    dlLimitBox.append(this.dlLimitUnit);
    this.box.append(dlLimitBox);

    const ulLimitBox = new Box(Orientation.HORIZONTAL, 2);
    ulLimitBox.setSizeRequest(120, -1);
    this.ulLimitEntry = new Entry();
    this.ulLimitEntry.setText("450");
    this.ulLimitEntry.setHexpand(true);
    ulLimitBox.append(this.ulLimitEntry);

    const unitsUl = new StringList();
    ["bps", "kbps", "mbps"].forEach((u) => unitsUl.append(u));
    this.ulLimitUnit = new DropDown(unitsUl);
    this.ulLimitUnit.setSelected(1); // kbps
    ulLimitBox.append(this.ulLimitUnit);
    this.box.append(ulLimitBox);

    this.activeCheck = new CheckButton();
    this.activeCheck.setSizeRequest(50, -1);
    this.activeCheck.setHalign(Align.CENTER);
    this.box.append(this.activeCheck);

    this.activeCheck.onToggled(() => this.updateLimit());
    this.dlLimitEntry.onChanged(() => {
      if (this.activeCheck.getActive()) this.updateLimit();
    });
    this.ulLimitEntry.onChanged(() => {
      if (this.activeCheck.getActive()) this.updateLimit();
    });
    this.dlLimitUnit.onSelectedChanged(() => {
      if (this.activeCheck.getActive()) this.updateLimit();
    });
    this.ulLimitUnit.onSelectedChanged(() => {
      if (this.activeCheck.getActive()) this.updateLimit();
    });
  }

  updateLimit() {
    const active = this.activeCheck.getActive();
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

const app = new Application("com.sigmasd.bandito", 0);

app.onActivate(() => {
  const window = new ApplicationWindow(app);
  window.setTitle("Bandito GTK");
  window.setDefaultSize(800, 600);

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

    await ensureBinaries((status, fraction) => {
      label.setText(status);
      progressBar.setFraction(fraction);
    });

    buildMainUI(window);
  } else {
    buildMainUI(window);
  }
}

async function buildMainUI(window: ApplicationWindow) {
  eltrafico = new ElTrafico();
  await eltrafico.interface(userInterface);

  const mainBox = new Box(Orientation.VERTICAL, 0);

  // Header Row
  const headerBox = new Box(Orientation.HORIZONTAL, 10);
  headerBox.setMarginTop(10);
  headerBox.setMarginBottom(10);
  headerBox.setMarginStart(10);
  headerBox.setMarginEnd(10);

  const labels = [
    { text: "Name", align: Align.START, width: 200 },
    { text: "DL Rate", width: 100 },
    { text: "UL Rate", width: 100 },
    { text: "DL Limit", width: 120 },
    { text: "UL Limit", width: 120 },
    { text: "Active", width: 50 },
  ];

  for (const l of labels) {
    const label = new Label(`<b>${l.text}</b>`);
    label.setUseMarkup(true);
    if (l.align) label.setHalign(l.align);
    label.setSizeRequest(l.width, -1);
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
          await eltrafico.stop();
          // Wait up to 5 seconds for clean exit
          const statusPromise = eltrafico.wait();
          const timeoutPromise = new Promise((r) =>
            setTimeout(() => r("timeout"), 5000)
          );
          const result = await Promise.race([statusPromise, timeoutPromise]);
          if (result === "timeout") {
            console.log("Forcing eltrafico kill...");
            eltrafico.kill();
          }
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
