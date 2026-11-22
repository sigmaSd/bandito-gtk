import {
  ActionRow,
  Clamp,
  PreferencesGroup,
  StatusPage,
  SwitchRow,
} from "@sigmasd/gtk/adw";
import {
  Align,
  Box,
  Button,
  CheckButton,
  Image,
  Label,
  Orientation,
  ProgressBar,
  ScrolledWindow,
  Spinner,
  type Widget,
} from "@sigmasd/gtk/gtk4";
import type { BinaryName, BinaryState } from "../utils/binary_manager.ts";
import { formatRate } from "../model/units.ts";
import {
  iconFor,
  type NetInterface,
  readCounters,
} from "../utils/network_interfaces.ts";

function page(
  icon: string,
  title: string,
  description: string,
  child: Widget,
): Widget {
  const status = new StatusPage();
  status.setIconName(icon);
  status.setTitle(title);
  status.setDescription(description);
  const clamp = new Clamp();
  clamp.setMaximumSize(440);
  clamp.setChild(child);
  status.setChild(clamp);
  const scroller = new ScrolledWindow();
  scroller.setVexpand(true);
  scroller.setChild(status);
  return scroller;
}

class StepRow {
  readonly row = new ActionRow();
  #icon = new Box(Orientation.HORIZONTAL, 0);
  #progress = new ProgressBar();

  constructor(title: string, subtitle: string) {
    this.row.setTitle(title);
    this.row.setSubtitle(subtitle);
    this.#icon.setSizeRequest(20, 20);
    this.#icon.setValign(Align.CENTER);
    this.row.addPrefix(this.#icon);
    this.#progress.setValign(Align.CENTER);
    this.#progress.setSizeRequest(90, -1);
    this.#progress.setVisible(false);
    this.row.addSuffix(this.#progress);
    this.waiting();
  }

  #setIcon(widget: Widget) {
    const old = this.#icon.getFirstChild();
    if (old) this.#icon.remove(old);
    this.#icon.append(widget);
  }

  waiting() {
    const image = new Image({ iconName: "content-loading-symbolic" });
    image.addCssClass("dim-label");
    this.#setIcon(image);
  }

  busy() {
    const spinner = new Spinner();
    spinner.start();
    this.#setIcon(spinner);
  }

  set(state: BinaryState) {
    this.row.setSubtitle(state.message);
    this.#progress.setVisible(state.phase === "downloading");
    this.#progress.setFraction(state.fraction);
    if (state.phase === "ready") {
      const image = new Image({ iconName: "object-select-symbolic" });
      image.addCssClass("success");
      this.#setIcon(image);
    } else if (state.phase === "failed") {
      const image = new Image({ iconName: "dialog-error-symbolic" });
      image.addCssClass("error");
      this.#setIcon(image);
    } else this.busy();
  }
}

/** Downloads the helpers, then explains the password prompt that follows. */
export class SetupPage {
  readonly widget: Widget;
  #steps: Record<BinaryName, StepRow>;
  #access: StepRow;
  #retry: Button;

  constructor(onRetry: () => void) {
    const box = new Box(Orientation.VERTICAL, 18);
    const group = new PreferencesGroup();
    this.#steps = {
      "bandwhich": new StepRow("Traffic monitor", "bandwhich"),
      "eltrafico-tc": new StepRow("Traffic shaper", "eltrafico-tc"),
    };
    this.#access = new StepRow(
      "Administrator access",
      "Requested after the downloads finish",
    );
    group.add(this.#steps.bandwhich.row);
    group.add(this.#steps["eltrafico-tc"].row);
    group.add(this.#access.row);
    box.append(group);

    this.#retry = new Button("Try Again");
    this.#retry.addCssClass("pill");
    this.#retry.addCssClass("suggested-action");
    this.#retry.setHalign(Align.CENTER);
    this.#retry.setVisible(false);
    this.#retry.onClick(() => {
      this.#retry.setVisible(false);
      onRetry();
    });
    box.append(this.#retry);

    this.widget = page(
      "security-high-symbolic",
      "Getting Ready",
      "Measuring and limiting traffic per app needs two small helpers and administrator access. You'll be asked for your password when monitoring starts.",
      box,
    );
  }

  update(binary: BinaryName, state: BinaryState) {
    this.#steps[binary].set(state);
  }

  /** Show that downloads failed and offer to try again. */
  failed() {
    this.#retry.setVisible(true);
  }

  requestingAccess() {
    this.#access.row.setSubtitle("Enter your password in the dialog");
    this.#access.busy();
  }
}

/** Lets the user pick the network to watch, with live traffic per network. */
export class InterfacePage {
  readonly widget: Widget;
  #timer: ReturnType<typeof setInterval>;

  constructor(
    interfaces: NetInterface[],
    rememberByDefault: boolean,
    onChoose: (iface: NetInterface, remember: boolean) => void,
  ) {
    const box = new Box(Orientation.VERTICAL, 18);
    const main = new PreferencesGroup();
    const virtualGroup = new PreferencesGroup();
    virtualGroup.setTitle("Virtual interfaces");
    virtualGroup.setVisible(false);

    let first: CheckButton | null = null;
    let selected: NetInterface | null = null;
    const rows: { iface: NetInterface; row: ActionRow; last: number | null }[] =
      [];
    for (const iface of interfaces) {
      const row = new ActionRow();
      row.setTitle(iface.label);
      const radio = new CheckButton();
      if (first) radio.setGroup(first);
      else first = radio;
      radio.setValign(Align.CENTER);
      radio.onToggled(() => {
        if (radio.getActive()) selected = iface;
      });
      row.addPrefix(radio);
      row.setActivatableWidget(radio);
      row.addSuffix(new Image({ iconName: iconFor(iface.kind) }));
      if (iface.isDefault) {
        const badge = new Label("In use");
        badge.addCssClass("badge");
        badge.setValign(Align.CENTER);
        row.addSuffix(badge);
      }
      row.setSensitive(iface.up);
      if (!selected && iface.up) {
        radio.setActive(true);
        selected = iface;
      }
      (iface.kind === "virtual" ? virtualGroup : main).add(row);
      if (iface.kind === "virtual") virtualGroup.setVisible(true);
      rows.push({ iface, row, last: readCounters(iface.name) });
    }
    box.append(main);

    if (rows.some((r) => r.iface.kind === "virtual")) {
      const toggle = new Button("Show Virtual Interfaces");
      toggle.addCssClass("flat");
      toggle.setHalign(Align.CENTER);
      virtualGroup.setVisible(false);
      toggle.onClick(() => {
        virtualGroup.setVisible(true);
        toggle.setVisible(false);
      });
      box.append(toggle);
      box.append(virtualGroup);
    }

    const rememberGroup = new PreferencesGroup();
    const remember = new SwitchRow();
    remember.setTitle("Use this network next time");
    remember.setSubtitle("Skip this step when Bandito starts");
    remember.setActive(rememberByDefault);
    rememberGroup.add(remember);
    box.append(rememberGroup);

    const go = new Button("Continue");
    go.addCssClass("pill");
    go.addCssClass("suggested-action");
    go.setHalign(Align.CENTER);
    go.setSensitive(selected !== null);
    go.onClick(() => {
      if (!selected) return;
      clearInterval(this.#timer);
      go.setSensitive(false);
      onChoose(selected, remember.getActive());
    });
    box.append(go);

    const describe = () => {
      for (const entry of rows) {
        const now = readCounters(entry.iface.name);
        const rate = now !== null && entry.last !== null
          ? Math.max(0, now - entry.last)
          : null;
        entry.last = now;
        const state = entry.iface.up ? "" : " · Not connected";
        const traffic = rate !== null && entry.iface.up
          ? ` · ${formatRate(rate, false)} now`
          : "";
        entry.row.setSubtitle(`${entry.iface.name}${state}${traffic}`);
      }
    };
    describe();
    this.#timer = setInterval(describe, 1000);

    this.widget = page(
      "network-wireless-symbolic",
      "Choose a Network",
      "Bandito watches one network at a time. You can switch later from the header bar.",
      box,
    );
  }

  dispose() {
    clearInterval(this.#timer);
  }
}

/** Shown when monitoring stops, e.g. because the password was refused. */
export function errorPage(
  title: string,
  description: string,
  onRetry: () => void,
): Widget {
  const retry = new Button("Try Again");
  retry.addCssClass("pill");
  retry.addCssClass("suggested-action");
  retry.setHalign(Align.CENTER);
  retry.onClick(onRetry);
  return page("dialog-password-symbolic", title, description, retry);
}
