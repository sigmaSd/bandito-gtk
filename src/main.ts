import {
  Align,
  Application,
  ApplicationWindow,
  Box,
  Button,
  CssProvider,
  Display,
  DropDown,
  Grid,
  HeaderBar,
  Label,
  Orientation,
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
import { AppRow } from "./app_row.ts";
import { ensureBinaries } from "./utils/binary_manager.ts";
import { getNetworkInterfaces } from "./utils/network_interfaces.ts";
import { isFlatpak, resolveFlatpakInstallPath } from "./utils/flatpak.ts";

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

  if (eltrafico) {
    await eltrafico.stop();
    await eltrafico.wait();
  }
  eventLoop.stop();
}

Deno.addSignalListener("SIGINT", () => {
  shutdown();
});

function ensureAppRow(name: string, isGlobal = false) {
  let appRow = appsMap.get(name);
  if (!appRow) {
    const row = isGlobal ? 1 : tableRowCount;
    appRow = new AppRow(tableGrid, row, eltrafico, name, isGlobal);
    appsMap.set(name, appRow);
    if (!isGlobal) tableRowCount++;
  }
  return appRow;
}

appRef = new Application("io.github.sigmasd.bandito", 0);

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

  window.onCloseRequest(() => {
    shutdown();
    return false;
  });

  if (!userInterface) {
    const interfaces = getNetworkInterfaces();
    if (interfaces.length === 0) {
      console.error("No network interfaces found.");
      Deno.exit(1);
    }

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
  if (isFlatpak()) {
    await resolveFlatpakInstallPath();
  }

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

  tableGrid = new Grid();
  tableGrid.setColumnSpacing(0);
  tableGrid.setRowSpacing(0);
  tableGrid.addCssClass("table-grid");
  tableGrid.setHexpand(true);

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

  tableRowCount = 2;

  const scrolled = new ScrolledWindow();
  scrolled.setVexpand(true);
  scrolled.setHexpand(true);
  scrolled.setMinContentHeight(400);
  scrolled.setChild(tableGrid);
  mainBox.append(scrolled);

  window.setChild(mainBox);
  window.present();

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
