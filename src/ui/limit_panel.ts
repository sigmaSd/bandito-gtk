import { PreferencesGroup, SpinRow, SwitchRow } from "@sigmasd/gtk/adw";
import {
  Align,
  Box,
  Button,
  Image,
  Label,
  ListBox,
  ListBoxRow,
  Orientation,
  PolicyType,
  ScrolledWindow,
  SelectionMode,
  ToggleButton,
  type Widget,
} from "@sigmasd/gtk/gtk4";
import type { Identity } from "../model/identity.ts";
import type { Limits } from "../model/settings.ts";
import {
  type ConnectionInfo,
  hasLimit,
  type ProcessInfo,
} from "../model/store.ts";
import { serviceName } from "../model/ports.ts";
import {
  formatLimit,
  formatRate,
  limitUnits,
  preferredUnit,
  type Rate,
} from "../model/units.ts";
import { appIcon } from "./app_icon.ts";

export type Direction = "download" | "upload";

/** What the panel is editing: one program, or all of them. */
export interface PanelTarget {
  key: string;
  name: string | null;
  identity: Identity;
  limits: Limits;
  download: Rate;
  upload: Rate;
  remembered: boolean;
}

export interface PanelActions {
  setLimit(direction: Direction, value: Rate | null): void;
  clearLimits(): void;
  setRemembered(remember: boolean): void;
  close(): void;
  bits(): boolean;
}

const PRESETS: Record<Direction, Rate[]> = {
  download: [256e3, 1e6, 2e6, 5e6],
  upload: [64e3, 256e3, 500e3, 1e6],
};

const DEFAULT_VALUE: Record<Direction, Rate> = {
  download: 1e6,
  upload: 256e3,
};

/** Wait this long after typing before applying a new value. */
const APPLY_DELAY = 600;

class DirectionEditor {
  readonly group = new PreferencesGroup();
  #toggle = new SwitchRow();
  #value: SpinRow;
  #units: ToggleButton[] = [];
  #presets: Button[] = [];
  #unit = 0;
  #syncing = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly direction: Direction,
    readonly actions: PanelActions,
  ) {
    const word = direction === "download" ? "download" : "upload";
    this.group.setTitle(direction === "download" ? "Download" : "Upload");

    this.#toggle.setTitle(`Limit ${word}`);
    this.#toggle.onActiveChanged((on) => {
      if (this.#syncing) return;
      this.#cancelPending();
      actions.setLimit(direction, on ? this.#typedValue() : null);
    });
    this.group.add(this.#toggle);

    this.#value = new SpinRow(0.1, 100000, 1);
    this.#value.setTitle("Max");
    this.#value.onValueChanged(() => {
      if (this.#syncing || !this.#toggle.getActive()) return;
      this.#cancelPending();
      this.#timer = setTimeout(() => {
        this.#timer = null;
        actions.setLimit(direction, this.#typedValue());
      }, APPLY_DELAY);
    });
    const units = new Box(Orientation.HORIZONTAL, 0);
    units.addCssClass("linked");
    units.setValign(Align.CENTER);
    for (let i = 0; i < 2; i++) {
      const button = new ToggleButton();
      if (i > 0) button.setGroup(this.#units[0]);
      button.onToggled(() => {
        if (this.#syncing || !button.getActive()) return;
        // Keep the typed number and read it in the new unit.
        this.#unit = i;
        this.#value.setDigits(i === 0 ? 0 : 1);
        if (this.#toggle.getActive()) {
          this.#cancelPending();
          actions.setLimit(direction, this.#typedValue());
        }
      });
      this.#units.push(button);
      units.append(button);
    }
    this.#value.addSuffix(units);
    this.group.add(this.#value);

    const presetRow = new ListBoxRow();
    presetRow.setActivatable(false);
    const presets = new Box(Orientation.HORIZONTAL, 6);
    presets.setMarginTop(10);
    presets.setMarginBottom(10);
    presets.setMarginStart(12);
    presets.setMarginEnd(12);
    for (const preset of PRESETS[direction]) {
      const button = new Button();
      button.addCssClass("preset");
      button.onClick(() => {
        this.#cancelPending();
        actions.setLimit(direction, preset);
      });
      this.#presets.push(button);
      presets.append(button);
    }
    presetRow.setChild(presets);
    this.group.add(presetRow);
  }

  #factor(): number {
    return limitUnits(this.actions.bits())[this.#unit].bytes;
  }

  #typedValue(): Rate {
    return Math.max(0.1, this.#value.getValue()) * this.#factor();
  }

  #cancelPending() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Show the target's current limit without applying anything. */
  sync(limit: Rate | null, rate: Rate, limitable: boolean) {
    this.#syncing = true;
    try {
      const bits = this.actions.bits();
      const units = limitUnits(bits);
      const shown = limit ?? DEFAULT_VALUE[this.direction];
      if (this.#timer === null) {
        this.#unit = preferredUnit(shown, bits);
        // Whole numbers for KB/s, one decimal for MB/s.
        this.#value.setDigits(this.#unit === 0 ? 0 : 1);
        this.#value.setValue(
          Math.round(shown / units[this.#unit].bytes * 10) / 10,
        );
      }
      units.forEach((u, i) => {
        this.#units[i].setLabel(u.label);
        this.#units[i].setActive(i === this.#unit);
      });
      this.#toggle.setActive(limit !== null);
      this.#toggle.setSensitive(limitable);
      this.#value.setSensitive(limitable && limit !== null);
      PRESETS[this.direction].forEach((preset, i) => {
        const button = this.#presets[i];
        button.setLabel(formatLimit(preset, bits));
        button.setSensitive(limitable);
        if (limit !== null && Math.abs(limit - preset) < 1) {
          button.addCssClass("selected");
        } else button.removeCssClass("selected");
      });
      this.updateRate(rate);
    } finally {
      this.#syncing = false;
    }
  }

  updateRate(rate: Rate) {
    const arrow = this.direction === "download" ? "↓" : "↑";
    this.#toggle.setSubtitle(
      `Now ${arrow} ${formatRate(rate, this.actions.bits())}`,
    );
  }

  flush() {
    if (this.#timer !== null) {
      this.#cancelPending();
      if (this.#toggle.getActive()) {
        this.actions.setLimit(this.direction, this.#typedValue());
      }
    }
  }
}

const UNIDENTIFIED_HELP =
  "Bandito sees this traffic but couldn't match it to a running program, so it can't be limited. Common reasons:\n" +
  "•  A program that finished before it could be identified\n" +
  "•  A container or virtual machine with its own network\n" +
  "•  System traffic such as local discovery, DHCP or a VPN tunnel\n\n" +
  "The connections below show where it's going.";

/** A row in the panel's lists: what it is, a detail line, and its rates. */
function trafficRow(
  title: string,
  detail: string,
  traffic: { download: Rate; upload: Rate; quietFor: number; exited?: boolean },
  bits: boolean,
): ListBoxRow {
  const row = new ListBoxRow();
  row.setActivatable(false);
  const box = new Box(Orientation.HORIZONTAL, 12);
  box.setMarginTop(8);
  box.setMarginBottom(8);
  box.setMarginStart(12);
  box.setMarginEnd(12);
  const text = new Box(Orientation.VERTICAL, 0);
  text.setHexpand(true);
  const name = new Label(title);
  name.setXalign(0);
  name.setEllipsize(2);
  name.setSelectable(true);
  name.setCanTarget(false);
  const sub = new Label(detail);
  sub.setXalign(0);
  sub.setEllipsize(3);
  sub.addCssClass("caption");
  sub.addCssClass("dim-label");
  text.append(name);
  text.append(sub);
  box.append(text);
  const active = traffic.download + traffic.upload > 0;
  const rate = new Label(
    active
      ? `↓ ${formatRate(traffic.download, bits)}\n↑ ${
        formatRate(traffic.upload, bits)
      }`
      : traffic.exited
      ? "Exited"
      : `Quiet ${traffic.quietFor} s`,
  );
  rate.setXalign(1);
  rate.addCssClass("caption");
  rate.addCssClass("numeric");
  if (!active) rate.addCssClass("dim-label");
  box.append(rate);
  row.setChild(box);
  return row;
}

/** A titled boxed list, for the panel's processes and connections. */
function trafficList(title: string, empty: string) {
  const box = new Box(Orientation.VERTICAL, 6);
  const heading = new Label(title);
  heading.setXalign(0);
  heading.setMarginStart(2);
  heading.addCssClass("heading");
  const list = new ListBox();
  list.addCssClass("boxed-list");
  list.setSelectionMode(SelectionMode.NONE);
  const placeholder = new Label(empty);
  placeholder.addCssClass("dim-label");
  placeholder.setMarginTop(14);
  placeholder.setMarginBottom(14);
  list.setPlaceholder(placeholder);
  box.append(heading);
  box.append(list);
  return { box, heading, list };
}

/** Sidebar for editing one target's download and upload limits. */
export class LimitPanel {
  readonly widget: Box;
  #header: Box;
  #live: Label;
  #notice: Label;
  #editors: Record<Direction, DirectionEditor>;
  #remember = new SwitchRow();
  #rememberGroup: PreferencesGroup;
  #footer: Box;
  #processes: Box;
  #processesTitle: Label;
  #processList: ListBox;
  /** Whether the target's traffic is split by process at all. */
  #hasProcesses = false;
  #connections: Box;
  #connectionsTitle: Label;
  #connectionList: ListBox;
  #clear: Button;
  #target: PanelTarget | null = null;
  #syncing = false;

  constructor(readonly actions: PanelActions) {
    this.widget = new Box(Orientation.VERTICAL, 0);
    this.widget.addCssClass("limit-panel");

    this.#header = new Box(Orientation.HORIZONTAL, 12);
    this.#header.setMarginTop(18);
    this.#header.setMarginStart(18);
    this.#header.setMarginEnd(12);
    this.widget.append(this.#header);

    this.#live = new Label("");
    this.#live.setXalign(0);
    this.#live.setMarginStart(18);
    this.#live.setMarginTop(8);
    this.#live.addCssClass("numeric");
    this.#live.addCssClass("panel-live");
    this.widget.append(this.#live);

    const scroller = new ScrolledWindow();
    scroller.setVexpand(true);
    scroller.setPolicy(PolicyType.NEVER, PolicyType.AUTOMATIC);
    const content = new Box(Orientation.VERTICAL, 18);
    content.setMarginTop(14);
    content.setMarginBottom(18);
    content.setMarginStart(14);
    content.setMarginEnd(14);

    this.#notice = new Label("");
    this.#notice.setWrap(true);
    this.#notice.setXalign(0);
    this.#notice.addCssClass("dim-label");
    this.#notice.setMarginStart(4);
    content.append(this.#notice);

    this.#editors = {
      download: new DirectionEditor("download", actions),
      upload: new DirectionEditor("upload", actions),
    };
    content.append(this.#editors.download.group);
    content.append(this.#editors.upload.group);

    this.#rememberGroup = new PreferencesGroup();
    this.#remember.setSubtitle("Applied again when Bandito starts");
    this.#remember.onActiveChanged((on) => {
      if (!this.#syncing) actions.setRemembered(on);
    });
    this.#rememberGroup.add(this.#remember);
    content.append(this.#rememberGroup);

    const processes = trafficList(
      "Processes",
      "No process traffic in the last minute",
    );
    this.#processes = processes.box;
    this.#processesTitle = processes.heading;
    this.#processList = processes.list;
    this.#processes.setVisible(false);
    content.append(this.#processes);

    const connections = trafficList(
      "Connections",
      "No connections in the last minute",
    );
    this.#connections = connections.box;
    this.#connectionsTitle = connections.heading;
    this.#connectionList = connections.list;
    content.append(this.#connections);

    scroller.setChild(content);
    this.widget.append(scroller);

    this.#footer = new Box(Orientation.HORIZONTAL, 0);
    this.#footer.addCssClass("panel-footer");
    this.#clear = new Button("Remove limits");
    this.#clear.setHexpand(true);
    this.#clear.addCssClass("destructive-action");
    this.#clear.onClick(() => actions.clearLimits());
    this.#footer.append(this.#clear);
    this.widget.append(this.#footer);
  }

  get target(): PanelTarget | null {
    return this.#target;
  }

  /** Show a target, rebuilding the header if it changed. */
  show(target: PanelTarget): void {
    const changed = this.#target?.key !== target.key;
    if (changed) {
      this.#editors.download.flush();
      this.#editors.upload.flush();
      this.#buildHeader(target);
    }
    this.#target = target;
    this.#syncing = true;
    try {
      const { identity } = target;
      const global = target.name === null;
      this.#notice.setText(
        global
          ? "Caps the combined traffic of every app. Per-app limits still apply inside it."
          : identity.limitable
          ? ""
          : UNIDENTIFIED_HELP,
      );
      this.#notice.setVisible(global || !identity.limitable);
      // Traffic without a program can't be limited, so show only what's known.
      this.#editors.download.group.setVisible(identity.limitable);
      this.#editors.upload.group.setVisible(identity.limitable);
      this.#rememberGroup.setVisible(identity.limitable);
      this.#footer.setVisible(identity.limitable);
      this.#connections.setVisible(!global);
      this.#processes.setVisible(!global && this.#hasProcesses);
      this.#editors.download.sync(
        target.limits.download,
        target.download,
        identity.limitable,
      );
      this.#editors.upload.sync(
        target.limits.upload,
        target.upload,
        identity.limitable,
      );
      this.#remember.setTitle(
        global ? "Remember for next time" : `Remember for ${identity.title}`,
      );
      this.#remember.setActive(target.remembered);
      this.#remember.setSensitive(identity.limitable);
      this.#clear.setSensitive(hasLimit(target.limits));
      this.updateRates(target.download, target.upload);
    } finally {
      this.#syncing = false;
    }
  }

  updateRates(download: Rate, upload: Rate): void {
    const bits = this.actions.bits();
    this.#live.setText(
      `↓ ${formatRate(download, bits)}    ↑ ${formatRate(upload, bits)}`,
    );
    this.#editors.download.updateRate(download);
    this.#editors.upload.updateRate(upload);
  }

  /** List the target's recent connections, busiest first. */
  updateConnections(connections: ConnectionInfo[]): void {
    const bits = this.actions.bits();
    this.#connectionsTitle.setText(
      connections.length
        ? `Connections · ${connections.length}`
        : "Connections",
    );
    this.#connectionList.removeAll();
    for (const c of connections) {
      const service = serviceName(c.remotePort);
      const row = trafficRow(
        c.host,
        `${service ? `${service} · ` : ""}port ${c.remotePort}/${c.protocol}`,
        c,
        bits,
      );
      row.setTooltipText(
        `${c.host}:${c.remotePort} (${c.protocol}) from local port ${c.localPort}`,
      );
      this.#connectionList.append(row);
    }
  }

  /**
   * List the target's recent processes, busiest first; null hides the list,
   * for netleash versions that don't split traffic by process.
   */
  updateProcesses(processes: ProcessInfo[] | null): void {
    this.#hasProcesses = processes !== null;
    this.#processes.setVisible(
      processes !== null && this.#target?.name !== null,
    );
    if (processes === null) return;
    const bits = this.actions.bits();
    this.#processesTitle.setText(
      processes.length ? `Processes · ${processes.length}` : "Processes",
    );
    this.#processList.removeAll();
    for (const p of processes) {
      const row = trafficRow(p.name, `PID ${p.pid}`, p, bits);
      row.setTooltipText(
        `Traffic of the connections ${p.name} (process ${p.pid}) opened`,
      );
      this.#processList.append(row);
    }
  }

  /** Apply a value still waiting for the typing delay. */
  flush(): void {
    this.#editors.download.flush();
    this.#editors.upload.flush();
  }

  #buildHeader(target: PanelTarget) {
    let child = this.#header.getFirstChild();
    while (child) {
      const next = this.#header.getNextSibling(child);
      this.#header.remove(child);
      child = next;
    }
    let icon: Widget;
    if (target.name === null) {
      const image = new Image({
        iconName: "network-transmit-receive-symbolic",
      });
      image.setPixelSize(24);
      const tile = new Box(Orientation.VERTICAL, 0);
      tile.addCssClass("app-tile");
      tile.addCssClass("global-tile");
      tile.setSizeRequest(44, 44);
      tile.setValign(Align.CENTER);
      tile.setVexpand(false);
      tile.setHexpand(false);
      image.setVexpand(true);
      tile.append(image);
      icon = tile;
    } else icon = appIcon(target.name, target.identity, 44);
    this.#header.append(icon);

    const names = new Box(Orientation.VERTICAL, 2);
    names.setHexpand(true);
    names.setValign(Align.CENTER);
    const title = new Label(target.identity.title);
    title.setXalign(0);
    title.setEllipsize(3);
    title.addCssClass("title-3");
    const subtitle = new Label(target.identity.subtitle);
    subtitle.setXalign(0);
    subtitle.setEllipsize(3);
    subtitle.addCssClass("dim-label");
    names.append(title);
    names.append(subtitle);
    this.#header.append(names);

    const close = new Button();
    close.setIconName("window-close-symbolic");
    close.addCssClass("flat");
    close.addCssClass("circular");
    close.setValign(Align.START);
    close.setTooltipText("Close");
    close.onClick(() => this.actions.close());
    this.#header.append(close);
  }
}
