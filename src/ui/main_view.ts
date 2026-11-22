import {
  AboutDialog,
  type AdwApplicationWindow,
  ButtonContent,
  Clamp,
  HeaderBar,
  OverlaySplitView,
  StyleManager,
  Toast,
  ToastOverlay,
  ToolbarView,
  WindowTitle,
} from "@sigmasd/gtk/adw";
import {
  Align,
  Box,
  Button,
  CheckButton,
  DrawingArea,
  EventControllerKey,
  EventControllerMotion,
  Image,
  Key,
  Label,
  ListBox,
  type ListBoxRow,
  MenuButton,
  ModifierType,
  Orientation,
  Overlay,
  PackType,
  PolicyType,
  Popover,
  ScrolledWindow,
  SearchBar,
  SearchEntry,
  SelectionMode,
  Separator,
  SizeGroup,
  SizeGroupMode,
  ToggleButton,
} from "@sigmasd/gtk/gtk4";
import type { Backend, LimitTarget } from "../backend/types.ts";
import { identify, type Identity } from "../model/identity.ts";
import { type Limits, saveSettings, type Settings } from "../model/settings.ts";
import {
  type AppEntry,
  hasLimit,
  noLimits,
  type Store,
  TOTAL_HISTORY,
} from "../model/store.ts";
import { formatLimit, formatRate, type Rate } from "../model/units.ts";
import {
  iconFor,
  listInterfaces,
  type NetInterface,
} from "../utils/network_interfaces.ts";
import { AppRow, type RowContext } from "./app_row.ts";
import { drawTotals, LABEL_BAND, palette, totalsScale } from "./charts.ts";
import { type Direction, LimitPanel, type PanelTarget } from "./limit_panel.ts";

const GLOBAL_KEY = "\u0000global";
const GLOBAL_IDENTITY: Identity = {
  title: "All apps",
  subtitle: "Total for every program",
  icon: null,
  limitable: true,
  keywords: "",
};

/** Reorder rows at most this often (in samples), so they don't jump around. */
const REORDER_EVERY = 3;

type SortKey = "download" | "upload";

export interface MainViewOptions {
  window: AdwApplicationWindow;
  backend: Backend;
  store: Store;
  settings: Settings;
  iface: NetInterface;
  version: string;
}

/** The main window: totals, the list of apps and the limit editor. */
export class MainView {
  readonly widget: ToolbarView;
  #opts: MainViewOptions;
  #iface: NetInterface;
  #dark: boolean;

  #title: WindowTitle;
  #ifaceContent: ButtonContent;
  #ifaceButton: MenuButton;
  #ifaceList: Box;
  #searchBar: SearchBar;
  #search: SearchEntry;
  #toasts: ToastOverlay;
  #split: OverlaySplitView;
  #panel: LimitPanel;

  #totalCaption: Label;
  #totalDown: Label;
  #totalUp: Label;
  #chart: DrawingArea;
  #chartMaxDown: Label;
  #chartMaxUp: Label;
  #globalState: Label;

  #list: ListBox;
  #listTitle: Label;
  #sortButtons: Record<SortKey, Button>;
  #idleButton: Button;
  #idleIcon: Image;
  #idleTitle: Label;
  #placeholder: Label;
  #listMotion: EventControllerMotion;

  #rows = new Map<string, AppRow>();
  #rowContext: RowContext;
  #sort: { key: SortKey; descending: boolean } = {
    key: "download",
    descending: true,
  };
  #showIdle = false;
  #query = "";
  #sinceReorder = 0;
  #remember = new Map<string, boolean>();
  #lastToast: Toast | null = null;

  constructor(opts: MainViewOptions) {
    this.#opts = opts;
    this.#iface = opts.iface;
    const style = StyleManager.getDefault();
    this.#dark = style.getDark();
    style.onDarkChanged((dark) => {
      this.#dark = dark;
      this.#applyPalette();
      this.#chart.queueDraw();
      for (const row of this.#rows.values()) row.refresh();
    });
    this.#applyPalette();

    this.#rowContext = {
      bits: () => this.#opts.settings.showBits,
      colors: () => palette(this.#dark),
      columns: {
        spark: new SizeGroup(SizeGroupMode.HORIZONTAL),
        download: new SizeGroup(SizeGroupMode.HORIZONTAL),
        upload: new SizeGroup(SizeGroupMode.HORIZONTAL),
        limit: new SizeGroup(SizeGroupMode.HORIZONTAL),
      },
    };

    // ---- header bar
    const header = new HeaderBar();
    this.#title = new WindowTitle("Bandito", "");
    header.setTitleWidget(this.#title);

    this.#ifaceButton = new MenuButton();
    this.#ifaceContent = new ButtonContent();
    this.#ifaceButton.setChild(this.#ifaceContent);
    this.#ifaceButton.setAlwaysShowArrow(true);
    this.#ifaceButton.setTooltipText("Network to monitor");
    const ifacePopover = new Popover();
    this.#ifaceList = new Box(Orientation.VERTICAL, 2);
    this.#ifaceList.setMarginTop(4);
    this.#ifaceList.setMarginBottom(4);
    ifacePopover.setChild(this.#ifaceList);
    ifacePopover.onNotify("visible", () => {
      if (ifacePopover.getVisible()) this.#fillInterfaceMenu();
    });
    this.#ifaceButton.setPopover(ifacePopover);
    header.packStart(this.#ifaceButton);

    const menuButton = new MenuButton();
    menuButton.setIconName("open-menu-symbolic");
    menuButton.setTooltipText("Main menu");
    menuButton.setPopover(this.#buildMenu(menuButton));
    header.packEnd(menuButton);

    const searchToggle = new ToggleButton();
    searchToggle.setIconName("system-search-symbolic");
    searchToggle.setTooltipText("Search apps");
    header.packEnd(searchToggle);

    // ---- search bar
    this.#searchBar = new SearchBar();
    this.#search = new SearchEntry();
    this.#search.setPlaceholderText("Search apps");
    const searchClamp = new Clamp();
    searchClamp.setMaximumSize(420);
    searchClamp.setChild(this.#search);
    this.#searchBar.setChild(searchClamp);
    this.#searchBar.connectEntry(this.#search);
    this.#searchBar.setKeyCaptureWidget(opts.window);
    searchToggle.onToggled(() =>
      this.#searchBar.setSearchMode(searchToggle.getActive())
    );
    this.#searchBar.onNotify("search-mode-enabled", () => {
      const on = this.#searchBar.getSearchMode();
      if (searchToggle.getActive() !== on) searchToggle.setActive(on);
      if (!on && this.#query) this.#search.setText("");
    });
    this.#search.onChanged(() => {
      this.#query = this.#search.getText().trim().toLowerCase();
      this.#relayout();
    });

    // ---- summary
    const summary = new Box(Orientation.HORIZONTAL, 20);

    const totals = new Box(Orientation.VERTICAL, 0);
    totals.setValign(Align.CENTER);
    this.#totalCaption = new Label("");
    this.#totalCaption.setXalign(0);
    this.#totalCaption.addCssClass("caption");
    this.#totalCaption.addCssClass("dim-label");
    this.#totalDown = new Label("↓ —");
    this.#totalDown.setXalign(0);
    this.#totalDown.setWidthChars(11);
    this.#totalDown.addCssClass("total-download");
    this.#totalDown.addCssClass("numeric");
    this.#totalUp = new Label("↑ —");
    this.#totalUp.setXalign(0);
    this.#totalUp.addCssClass("total-upload");
    this.#totalUp.addCssClass("numeric");
    totals.append(this.#totalCaption);
    totals.append(this.#totalDown);
    totals.append(this.#totalUp);
    summary.append(totals);

    const chartOverlay = new Overlay();
    chartOverlay.setHexpand(true);
    this.#chart = new DrawingArea();
    this.#chart.setContentHeight(88 + 2 * LABEL_BAND);
    this.#chart.setHexpand(true);
    this.#chart.setDrawFunc((_area, cr, width, height) =>
      drawTotals(
        cr,
        width,
        height,
        opts.store.totals.history,
        TOTAL_HISTORY,
        palette(this.#dark),
      )
    );
    chartOverlay.setChild(this.#chart);
    this.#chartMaxDown = this.#chartLabel(Align.START);
    this.#chartMaxUp = this.#chartLabel(Align.END);
    chartOverlay.addOverlay(this.#chartMaxDown);
    chartOverlay.addOverlay(this.#chartMaxUp);
    chartOverlay.setTooltipText("Total traffic over the last minute");
    summary.append(chartOverlay);

    const globalCard = new Button();
    globalCard.addCssClass("card");
    globalCard.addCssClass("global-card");
    globalCard.setSizeRequest(200, -1);
    const cardBox = new Box(Orientation.VERTICAL, 6);
    cardBox.setValign(Align.CENTER);
    const cardTop = new Box(Orientation.HORIZONTAL, 6);
    cardTop.append(
      new Image({ iconName: "network-transmit-receive-symbolic" }),
    );
    const cardCaption = new Label("Limit for all apps");
    cardCaption.addCssClass("caption");
    cardTop.append(cardCaption);
    cardTop.addCssClass("dim-label");
    this.#globalState = new Label("");
    this.#globalState.setXalign(0);
    this.#globalState.addCssClass("heading");
    this.#globalState.addCssClass("numeric");
    cardBox.append(cardTop);
    cardBox.append(this.#globalState);
    globalCard.setChild(cardBox);
    globalCard.onClick(() => this.#openPanel(GLOBAL_KEY));
    summary.append(globalCard);

    // ---- list header
    const listHeader = new Box(Orientation.HORIZONTAL, 12);
    listHeader.setMarginStart(12);
    listHeader.setMarginEnd(12);
    listHeader.addCssClass("list-header");
    const iconSpace = new Box(Orientation.HORIZONTAL, 0);
    iconSpace.setSizeRequest(32, -1);
    listHeader.append(iconSpace);
    this.#listTitle = new Label("Active");
    this.#listTitle.setXalign(0);
    this.#listTitle.setHexpand(true);
    this.#listTitle.addCssClass("heading");
    listHeader.append(this.#listTitle);
    const sparkHeading = this.#columnLabel("Last 30 s", 0);
    this.#rowContext.columns.spark.addWidget(sparkHeading);
    listHeader.append(sparkHeading);
    this.#sortButtons = {
      download: this.#sortButton("download", "Download"),
      upload: this.#sortButton("upload", "Upload"),
    };
    this.#rowContext.columns.download.addWidget(this.#sortButtons.download);
    this.#rowContext.columns.upload.addWidget(this.#sortButtons.upload);
    listHeader.append(this.#sortButtons.download);
    listHeader.append(this.#sortButtons.upload);
    const limitHeading = this.#columnLabel("Limit", 1);
    this.#rowContext.columns.limit.addWidget(limitHeading);
    listHeader.append(limitHeading);

    // ---- list
    this.#list = new ListBox();
    this.#list.addCssClass("boxed-list");
    this.#list.setSelectionMode(SelectionMode.NONE);
    this.#list.setSortFunc((a, b) => this.#compare(a, b));
    this.#list.setFilterFunc((row) => this.#visible(row));
    this.#list.onRowActivated((row) => {
      if (row instanceof AppRow) this.#openPanel(row.entry.name);
    });
    this.#placeholder = new Label("");
    this.#placeholder.addCssClass("dim-label");
    this.#placeholder.setMarginTop(24);
    this.#placeholder.setMarginBottom(24);
    this.#list.setPlaceholder(this.#placeholder);
    this.#listMotion = new EventControllerMotion();
    this.#list.addController(this.#listMotion);
    this.#listMotion.onLeave(() => {
      if (this.#sinceReorder >= REORDER_EVERY) this.#relayout();
    });

    this.#idleButton = new Button();
    this.#idleButton.addCssClass("flat");
    this.#idleButton.addCssClass("idle-toggle");
    const idleBox = new Box(Orientation.HORIZONTAL, 10);
    this.#idleIcon = new Image({ iconName: "pan-end-symbolic" });
    this.#idleTitle = new Label("Idle apps");
    this.#idleTitle.addCssClass("heading");
    const idleHint = new Label("No traffic in the last 15 seconds");
    idleHint.addCssClass("caption");
    idleHint.addCssClass("dim-label");
    idleHint.setHexpand(true);
    idleHint.setXalign(1);
    idleBox.append(this.#idleIcon);
    idleBox.append(this.#idleTitle);
    idleBox.append(idleHint);
    this.#idleButton.setChild(idleBox);
    this.#idleButton.onClick(() => {
      this.#showIdle = !this.#showIdle;
      this.#relayout();
    });

    const content = new Box(Orientation.VERTICAL, 12);
    content.setMarginTop(20);
    content.setMarginBottom(28);
    content.setMarginStart(18);
    content.setMarginEnd(18);
    content.append(summary);
    const listSpacer = new Box(Orientation.VERTICAL, 0);
    listSpacer.setSizeRequest(-1, 6);
    content.append(listSpacer);
    content.append(listHeader);
    content.append(this.#list);
    content.append(this.#idleButton);

    const clamp = new Clamp();
    clamp.setMaximumSize(1100);
    clamp.setChild(content);
    const scroller = new ScrolledWindow();
    scroller.setPolicy(PolicyType.NEVER, PolicyType.AUTOMATIC);
    scroller.setVexpand(true);
    scroller.setChild(clamp);

    // ---- limit editor
    this.#panel = new LimitPanel({
      setLimit: (direction, value) => this.#setDirection(direction, value),
      clearLimits: () => {
        const key = this.#panel.target?.key;
        if (key) this.#applyLimits(key, noLimits());
      },
      setRemembered: (on) => {
        const key = this.#panel.target?.key;
        if (!key) return;
        this.#remember.set(key, on);
        this.#persist(key);
      },
      close: () => this.#split.setShowSidebar(false),
      bits: () => this.#opts.settings.showBits,
    });
    this.#split = new OverlaySplitView();
    this.#split.setCollapsed(true);
    this.#split.setSidebarPosition(PackType.END);
    this.#split.setMinSidebarWidth(370);
    this.#split.setMaxSidebarWidth(400);
    this.#split.setContent(scroller);
    this.#split.setSidebar(this.#panel.widget);
    this.#split.onShowSidebarChanged((shown) => {
      if (!shown) {
        this.#panel.flush();
        for (const row of this.#rows.values()) row.removeCssClass("editing");
      }
    });

    this.#toasts = new ToastOverlay();
    this.#toasts.setChild(this.#split);

    this.widget = new ToolbarView();
    this.widget.addTopBar(header);
    this.widget.addTopBar(this.#searchBar);
    this.widget.setContent(this.#toasts);

    const keys = new EventControllerKey();
    keys.onKeyPressed((keyval, _code, state) => {
      if (keyval === Key.Escape && this.#split.getShowSidebar()) {
        this.#split.setShowSidebar(false);
        return true;
      }
      if (
        (keyval === Key.f || keyval === Key.F) &&
        (state & ModifierType.CONTROL_MASK)
      ) {
        this.#searchBar.setSearchMode(!this.#searchBar.getSearchMode());
        return true;
      }
      return false;
    });
    opts.window.addController(keys);

    // ---- data
    opts.store.onAdded = (entry) => this.#addRow(entry);
    opts.store.onSample = () => this.#onSample();
    for (const entry of opts.store.apps.values()) this.#addRow(entry);
    this.#updateInterface();
    this.#refreshAll();
    this.#relayout();
  }

  // ------------------------------------------------------------------ helpers

  #applyPalette() {
    if (this.#dark) this.#opts.window.addCssClass("palette-dark");
    else this.#opts.window.removeCssClass("palette-dark");
  }

  #chartLabel(valign: number): Label {
    const label = new Label("");
    label.setHalign(Align.START);
    label.setValign(valign);
    label.addCssClass("caption");
    label.addCssClass("dim-label");
    label.addCssClass("numeric");
    label.addCssClass("chart-label");
    label.setCanTarget(false);
    return label;
  }

  #columnLabel(text: string, xalign: number): Label {
    const label = new Label(text);
    label.setXalign(xalign);
    label.addCssClass("caption");
    label.addCssClass("dim-label");
    return label;
  }

  #sortButton(key: SortKey, text: string): Button {
    const button = new Button(text);
    button.addCssClass("flat");
    button.addCssClass("sort-button");
    button.setHalign(Align.FILL);
    button.onClick(() => {
      this.#sort = this.#sort.key === key
        ? { key, descending: !this.#sort.descending }
        : { key, descending: true };
      this.#updateSortButtons();
      this.#relayout();
    });
    return button;
  }

  #updateSortButtons() {
    for (const key of ["download", "upload"] as SortKey[]) {
      const button = this.#sortButtons[key];
      const label = key === "download" ? "Download" : "Upload";
      if (this.#sort.key === key) {
        button.setLabel(`${label} ${this.#sort.descending ? "↓" : "↑"}`);
        button.addCssClass("sorted");
      } else {
        button.setLabel(label);
        button.removeCssClass("sorted");
      }
    }
  }

  #buildMenu(menuButton: MenuButton): Popover {
    const popover = new Popover();
    const box = new Box(Orientation.VERTICAL, 2);
    box.setMarginTop(6);
    box.setMarginBottom(6);
    box.setMarginStart(6);
    box.setMarginEnd(6);

    const bits = new CheckButton("Show rates in bits");
    bits.setActive(this.#opts.settings.showBits);
    bits.onToggled(() => {
      this.#opts.settings.showBits = bits.getActive();
      saveSettings(this.#opts.settings);
      this.#refreshAll();
      this.#chart.queueDraw();
      const target = this.#panel.target;
      if (target) this.#panel.show(this.#panelTarget(target.key));
    });
    box.append(bits);

    const restore = new CheckButton("Restore limits on start");
    restore.setActive(this.#opts.settings.restoreLimits);
    restore.onToggled(() => {
      this.#opts.settings.restoreLimits = restore.getActive();
      saveSettings(this.#opts.settings);
    });
    box.append(restore);
    box.append(new Separator(Orientation.HORIZONTAL));

    const item = (label: string, run: () => void) => {
      const button = new Button(label);
      button.addCssClass("flat");
      button.addCssClass("menu-item");
      button.onClick(() => {
        menuButton.popdown();
        run();
      });
      box.append(button);
    };
    item("Remove All Limits", () => this.#removeAllLimits());
    item("About Bandito", () => {
      const about = new AboutDialog();
      about.setApplicationName("Bandito");
      about.setApplicationIcon("io.github.sigmasd.bandito");
      about.setVersion(this.#opts.version);
      about.setDeveloperName("sigmaSd");
      about.setComments("Watch and limit network traffic per app.");
      about.setWebsite("https://github.com/sigmaSd/bandito-gtk");
      about.setIssueUrl("https://github.com/sigmaSd/bandito-gtk/issues");
      about.present(this.#opts.window);
    });
    popover.setChild(box);
    return popover;
  }

  // ---------------------------------------------------------------- network

  #updateInterface() {
    this.#ifaceContent.setIconName(iconFor(this.#iface.kind));
    this.#ifaceContent.setLabel(this.#iface.label);
    this.#totalCaption.setText(`Total on ${this.#iface.name}`);
    this.#updateSubtitle();
  }

  #updateSubtitle() {
    const active = this.#opts.store.activeCount();
    this.#title.setSubtitle(
      `${this.#iface.name} · ${active} ${active === 1 ? "app" : "apps"} active`,
    );
  }

  #fillInterfaceMenu() {
    let child = this.#ifaceList.getFirstChild();
    while (child) {
      const next = this.#ifaceList.getNextSibling(child);
      this.#ifaceList.remove(child);
      child = next;
    }
    const heading = new Label("Monitor network");
    heading.setXalign(0);
    heading.setMarginStart(10);
    heading.setMarginTop(4);
    heading.setMarginBottom(4);
    heading.addCssClass("caption-heading");
    heading.addCssClass("dim-label");
    this.#ifaceList.append(heading);

    for (const iface of listInterfaces()) {
      const button = new Button();
      button.addCssClass("flat");
      button.addCssClass("menu-item");
      const row = new Box(Orientation.HORIZONTAL, 10);
      row.append(new Image({ iconName: iconFor(iface.kind) }));
      const text = new Box(Orientation.VERTICAL, 0);
      text.setHexpand(true);
      const title = new Label(iface.label);
      title.setXalign(0);
      const detail = new Label(
        `${iface.name} · ${iface.up ? "Connected" : "Not connected"}`,
      );
      detail.setXalign(0);
      detail.addCssClass("caption");
      detail.addCssClass("dim-label");
      text.append(title);
      text.append(detail);
      row.append(text);
      const check = new Image({ iconName: "object-select-symbolic" });
      check.setOpacity(iface.name === this.#iface.name ? 1 : 0);
      row.append(check);
      button.setChild(row);
      button.setSensitive(iface.up);
      button.onClick(() => {
        this.#ifaceButton.popdown();
        this.#switchInterface(iface);
      });
      this.#ifaceList.append(button);
    }
  }

  async #switchInterface(iface: NetInterface) {
    if (iface.name === this.#iface.name) return;
    this.#iface = iface;
    this.#opts.store.resetHistory();
    this.#updateInterface();
    this.#refreshAll();
    this.#relayout();
    try {
      await this.#opts.backend.switchInterface(iface.name);
      // Limits belong to the old interface's queues; apply them again.
      for (const entry of this.#opts.store.apps.values()) {
        if (hasLimit(entry.limits)) {
          await this.#opts.backend.setLimits(
            { kind: "app", name: entry.name },
            entry.limits,
          );
        }
      }
      if (hasLimit(this.#opts.store.totals.limits)) {
        await this.#opts.backend.setLimits(
          { kind: "global" },
          this.#opts.store.totals.limits,
        );
      }
      if (this.#opts.settings.interface !== null) {
        this.#opts.settings.interface = iface.name;
        saveSettings(this.#opts.settings);
      }
      this.#toast(`Now monitoring ${iface.label} (${iface.name})`);
    } catch (e) {
      this.#toast(`Couldn't switch to ${iface.name}: ${message(e)}`);
    }
  }

  // ------------------------------------------------------------------- rows

  #addRow(entry: AppEntry) {
    if (this.#rows.has(entry.name)) return;
    const settings = this.#opts.settings;
    const saved = settings.limits[entry.name];
    if (saved && settings.restoreLimits && identify(entry.name).limitable) {
      entry.limits = { ...saved };
      this.#opts.backend.setLimits({ kind: "app", name: entry.name }, saved)
        .catch((e) =>
          this.#toast(
            `Couldn't restore limits for ${entry.name}: ${message(e)}`,
          )
        );
    }
    const row = new AppRow(entry, this.#rowContext);
    this.#rows.set(entry.name, row);
    this.#list.append(row);
    this.#sinceReorder = REORDER_EVERY;
  }

  #compare(a: ListBoxRow, b: ListBoxRow): number {
    if (!(a instanceof AppRow) || !(b instanceof AppRow)) return 0;
    const store = this.#opts.store;
    const activeA = store.isActive(a.entry);
    const activeB = store.isActive(b.entry);
    if (activeA !== activeB) return activeA ? -1 : 1;
    if (!activeA) return a.identity.title.localeCompare(b.identity.title);
    const key = this.#sort.key;
    const diff = a.entry[key] - b.entry[key];
    if (diff !== 0) return this.#sort.descending ? -diff : diff;
    return a.identity.title.localeCompare(b.identity.title);
  }

  #matches(row: AppRow): boolean {
    return !this.#query || row.identity.keywords.includes(this.#query) ||
      row.entry.name.toLowerCase().includes(this.#query);
  }

  #visible(row: ListBoxRow): boolean {
    if (!(row instanceof AppRow)) return true;
    if (!this.#matches(row)) return false;
    return this.#query !== "" || this.#showIdle ||
      this.#opts.store.isActive(row.entry);
  }

  /** Re-sort and re-filter now, and update the counts around the list. */
  #relayout() {
    this.#sinceReorder = 0;
    let active = 0;
    let idle = 0;
    let matching = 0;
    for (const row of this.#rows.values()) {
      const isActive = this.#opts.store.isActive(row.entry);
      row.setIdle(!isActive);
      if (!this.#matches(row)) continue;
      matching++;
      if (isActive) active++;
      else idle++;
    }
    this.#list.invalidateSort();
    this.#list.invalidateFilter();

    if (this.#query) {
      this.#listTitle.setText(`Results · ${matching}`);
      this.#placeholder.setText(`No app matches “${this.#search.getText()}”`);
    } else {
      this.#listTitle.setText(`Active · ${active}`);
      this.#placeholder.setText(
        this.#rows.size === 0
          ? "Waiting for traffic…"
          : "Nothing is using the network right now",
      );
    }
    this.#idleButton.setVisible(this.#query === "" && idle > 0);
    this.#idleTitle.setText(`Idle apps · ${idle}`);
    this.#idleIcon.setFromIconName(
      this.#showIdle ? "pan-down-symbolic" : "pan-end-symbolic",
    );
    this.#updateSortButtons();
  }

  #onSample() {
    const totals = this.#opts.store.totals;
    const bits = this.#opts.settings.showBits;
    this.#totalDown.setText(`↓ ${formatRate(totals.download, bits)}`);
    this.#totalUp.setText(`↑ ${formatRate(totals.upload, bits)}`);
    this.#chart.queueDraw();
    this.#updateChartLabels();
    for (const row of this.#rows.values()) row.refresh();
    this.#updateSubtitle();
    const target = this.#panel.target;
    if (target && this.#split.getShowSidebar()) {
      const { download, upload } = this.#rates(target.key);
      this.#panel.updateRates(download, upload);
      this.#updatePanelConnections(target.key);
    }
    this.#sinceReorder++;
    if (
      this.#sinceReorder >= REORDER_EVERY && !this.#listMotion.containsPointer()
    ) this.#relayout();
  }

  #refreshAll() {
    const totals = this.#opts.store.totals;
    const bits = this.#opts.settings.showBits;
    this.#totalDown.setText(`↓ ${formatRate(totals.download, bits)}`);
    this.#totalUp.setText(`↑ ${formatRate(totals.upload, bits)}`);
    for (const row of this.#rows.values()) row.refresh();
    this.#updateChartLabels();
    this.#updateGlobalCard();
  }

  #updateChartLabels() {
    const { maxDownload, maxUpload } = totalsScale(
      this.#opts.store.totals.history,
    );
    const bits = this.#opts.settings.showBits;
    this.#chartMaxDown.setText(`↓ ${formatRate(maxDownload, bits)}`);
    this.#chartMaxUp.setText(`↑ ${formatRate(maxUpload, bits)}`);
  }

  #updateGlobalCard() {
    const limits = this.#opts.store.totals.limits;
    const bits = this.#opts.settings.showBits;
    const parts: string[] = [];
    if (limits.download !== null) {
      parts.push(`↓ ${formatLimit(limits.download, bits)}`);
    }
    if (limits.upload !== null) {
      parts.push(`↑ ${formatLimit(limits.upload, bits)}`);
    }
    this.#globalState.setText(parts.length ? parts.join("   ") : "Off");
  }

  // ----------------------------------------------------------------- limits

  #rates(key: string): { download: Rate; upload: Rate } {
    if (key === GLOBAL_KEY) return this.#opts.store.totals;
    return this.#opts.store.apps.get(key) ?? { download: 0, upload: 0 };
  }

  #limitsOf(key: string): Limits {
    if (key === GLOBAL_KEY) return this.#opts.store.totals.limits;
    return this.#opts.store.apps.get(key)?.limits ?? noLimits();
  }

  #panelTarget(key: string): PanelTarget {
    const global = key === GLOBAL_KEY;
    const { download, upload } = this.#rates(key);
    return {
      key,
      name: global ? null : key,
      identity: global ? GLOBAL_IDENTITY : identify(key),
      limits: { ...this.#limitsOf(key) },
      download,
      upload,
      remembered: this.#remember.get(key) ?? true,
    };
  }

  #openPanel(key: string) {
    for (const [name, row] of this.#rows) {
      if (name === key) row.addCssClass("editing");
      else row.removeCssClass("editing");
    }
    this.#panel.show(this.#panelTarget(key));
    this.#updatePanelConnections(key);
    this.#split.setShowSidebar(true);
  }

  #updatePanelConnections(key: string) {
    const entry = this.#opts.store.apps.get(key);
    if (entry) {
      this.#panel.updateConnections(this.#opts.store.recentConnections(entry));
    }
  }

  #setDirection(direction: Direction, value: Rate | null) {
    const key = this.#panel.target?.key;
    if (!key) return;
    const current = this.#limitsOf(key);
    this.#applyLimits(key, { ...current, [direction]: value });
  }

  #persist(key: string) {
    const settings = this.#opts.settings;
    const limits = this.#limitsOf(key);
    const keep = (this.#remember.get(key) ?? true) && hasLimit(limits);
    if (key === GLOBAL_KEY) {
      settings.globalLimits = keep ? { ...limits } : noLimits();
    } else if (keep) settings.limits[key] = { ...limits };
    else delete settings.limits[key];
    saveSettings(settings);
  }

  #target(key: string): LimitTarget {
    return key === GLOBAL_KEY ? { kind: "global" } : { kind: "app", name: key };
  }

  /** Apply limits, update every view of them, and offer Undo. */
  #applyLimits(key: string, limits: Limits, options = { toast: true }) {
    const previous = { ...this.#limitsOf(key) };
    if (
      previous.download === limits.download &&
      previous.upload === limits.upload
    ) return;
    if (key === GLOBAL_KEY) this.#opts.store.totals.limits = { ...limits };
    else {
      const entry = this.#opts.store.apps.get(key);
      if (!entry) return;
      entry.limits = { ...limits };
    }
    this.#persist(key);
    this.#rows.get(key)?.refresh();
    this.#updateGlobalCard();
    if (this.#panel.target?.key === key) {
      this.#panel.show(this.#panelTarget(key));
    }
    this.#sinceReorder = REORDER_EVERY;

    this.#opts.backend.setLimits(this.#target(key), limits).catch((e) => {
      this.#toast(`Couldn't apply the limit: ${message(e)}`);
    });
    if (options.toast) {
      this.#toast(
        this.#describeChange(key, previous, limits),
        () => this.#applyLimits(key, previous, { toast: false }),
      );
    }
  }

  #describeChange(key: string, before: Limits, after: Limits): string {
    const who = key === GLOBAL_KEY ? "Total" : identify(key).title;
    const bits = this.#opts.settings.showBits;
    if (!hasLimit(after)) {
      return key === GLOBAL_KEY
        ? "Limit for all apps removed"
        : `Limits removed from ${who}`;
    }
    const changed = (["download", "upload"] as Direction[]).filter((d) =>
      before[d] !== after[d]
    );
    if (changed.length !== 1) return `${who} limits updated`;
    const direction = changed[0];
    const value = after[direction];
    return value === null
      ? `${who} ${direction} limit removed`
      : `${who} ${direction} limited to ${formatLimit(value, bits)}`;
  }

  #removeAllLimits() {
    const snapshot = new Map<string, Limits>();
    for (const entry of this.#opts.store.apps.values()) {
      if (hasLimit(entry.limits)) snapshot.set(entry.name, { ...entry.limits });
    }
    if (hasLimit(this.#opts.store.totals.limits)) {
      snapshot.set(GLOBAL_KEY, { ...this.#opts.store.totals.limits });
    }
    if (snapshot.size === 0) {
      this.#toast("No limits to remove");
      return;
    }
    for (const key of snapshot.keys()) {
      this.#applyLimits(key, noLimits(), { toast: false });
    }
    this.#toast("All limits removed", () => {
      for (const [key, limits] of snapshot) {
        this.#applyLimits(key, limits, { toast: false });
      }
    });
  }

  /** Re-apply global limits saved from an earlier session. */
  restoreGlobalLimits() {
    const saved = this.#opts.settings.globalLimits;
    if (!this.#opts.settings.restoreLimits || !hasLimit(saved)) return;
    this.#opts.store.totals.limits = { ...saved };
    this.#updateGlobalCard();
    this.#opts.backend.setLimits({ kind: "global" }, saved).catch((e) =>
      this.#toast(`Couldn't restore the limit for all apps: ${message(e)}`)
    );
  }

  #toast(title: string, undo?: () => void) {
    // A newer message replaces the current one instead of queueing behind it.
    this.#lastToast?.dismiss();
    const toast = new Toast(title);
    this.#lastToast = toast;
    toast.onDismissed(() => {
      if (this.#lastToast === toast) this.#lastToast = null;
    });
    toast.setTimeout(undo ? 3 : 2);
    if (undo) {
      toast.setButtonLabel("Undo");
      toast.onButtonClicked(undo);
    }
    this.#toasts.addToast(toast);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
