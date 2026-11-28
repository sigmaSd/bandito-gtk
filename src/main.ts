import { AdwApplicationWindow } from "@sigmasd/gtk/adw";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import {
  Application,
  ApplicationFlags,
  CssProvider,
  Display,
  StyleContext,
  StyleProviderPriority,
} from "@sigmasd/gtk/gtk4";
import config from "../deno.json" with { type: "json" };
import styles from "./styles.css" with { type: "text" };
import { DemoBackend } from "./backend/demo.ts";
import { EbpfBackend, netleashPlan } from "./backend/ebpf.ts";
import type { Backend } from "./backend/types.ts";
import {
  loadSettings,
  saveSettings,
  saveSettingsNow,
} from "./model/settings.ts";
import { Store } from "./model/store.ts";
import { MainView } from "./ui/main_view.ts";
import { findUpdate, type Release } from "./utils/updates.ts";
import { errorPage, InterfacePage, SetupPage } from "./ui/setup_pages.ts";
import {
  type BinaryName,
  ensureBinaries,
  helperLaunch,
} from "./utils/binary_manager.ts";
import {
  listInterfaces,
  type NetInterface,
} from "./utils/network_interfaces.ts";

/** BANDITO_DEMO=1 shows simulated traffic without root or downloads. */
const DEMO = Deno.env.get("BANDITO_DEMO") === "1";
/**
 * How netleash runs: as the user when it has its file capabilities,
 * otherwise as the pinned download, checked and run as root through pkexec.
 */
const NETLEASH = DEMO ? null : netleashPlan();
/** The helpers to download first, if any. */
const DOWNLOADS: BinaryName[] = NETLEASH?.kind === "pinned" ? ["netleash"] : [];
/** Show the setup page only if getting ready takes longer than this. */
const SETUP_PAGE_DELAY = 400;

const settings = loadSettings();
// Demo windows run alongside a real instance instead of raising it.
const app = new Application(
  "io.github.sigmasd.bandito",
  DEMO ? ApplicationFlags.NON_UNIQUE : ApplicationFlags.NONE,
);
const eventLoop = new EventLoop();
let window: AdwApplicationWindow;
let backend: Backend | null = null;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveSettingsNow(settings);
  try {
    await backend?.stop();
  } catch (e) {
    console.error("Error while stopping:", e);
  }
  eventLoop.stop();
}

Deno.addSignalListener("SIGINT", () => shutdown());

app.onActivate(() => {
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

  window = new AdwApplicationWindow(app);
  window.setTitle("Bandito");
  window.setDefaultSize(1040, 720);
  window.setSizeRequest(760, 480);
  window.onCloseRequest(() => {
    shutdown();
    return false;
  });
  window.present();
  start();
});

async function start() {
  if (DOWNLOADS.length && !(await prepareHelpers())) return;
  const iface = await chooseInterface();
  if (iface) await monitor(iface);
}

/** Download or update the helper programs. Returns false if that failed. */
function prepareHelpers(): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = async () => {
      const setup = new SetupPage(DOWNLOADS, attempt);
      const timer = setTimeout(
        () => window.setContent(setup.widget),
        SETUP_PAGE_DELAY,
      );
      const errors = await ensureBinaries(
        DOWNLOADS,
        (binary, state) => setup.update(binary, state),
      );
      clearTimeout(timer);
      if (errors.length === 0) resolve(true);
      else {
        window.setContent(setup.widget);
        setup.failed();
      }
    };
    attempt();
  });
}

function fromName(name: string): NetInterface {
  return listInterfaces().find((i) => i.name === name) ?? {
    name,
    kind: "ethernet",
    label: name,
    up: true,
    isDefault: false,
  };
}

/** The interface from the command line, the saved choice, or the picker. */
function chooseInterface(): Promise<NetInterface | null> {
  const requested = Deno.args[0];
  if (requested) return Promise.resolve(fromName(requested));
  const interfaces = listInterfaces();
  const saved = interfaces.find((i) => i.name === settings.interface && i.up);
  if (saved) return Promise.resolve(saved);
  if (interfaces.length === 0) {
    window.setContent(
      errorPage(
        "No Network Found",
        "Bandito couldn't find a network interface to monitor. Connect to a network and try again.",
        () => start(),
      ),
    );
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const picker = new InterfacePage(
      interfaces,
      true,
      (iface, remember) => {
        picker.dispose();
        settings.interface = remember ? iface.name : null;
        saveSettings(settings);
        resolve(iface);
      },
    );
    window.setContent(picker.widget);
  });
}

let update: Promise<Release | null> | null = null;

/** Show a newer release on the view, asking GitHub once per start. */
function offerUpdate(view: MainView) {
  if (!settings.checkUpdates) return;
  update ??= findUpdate(config.version);
  update.then((release) => {
    if (release && settings.checkUpdates) view.showUpdate(release);
  });
}

async function monitor(iface: NetInterface) {
  const store = new Store();
  const current: Backend = NETLEASH
    ? new EbpfBackend(() =>
      NETLEASH.kind === "pinned"
        ? helperLaunch("netleash")
        : { command: NETLEASH.command, script: null }
    )
    : new DemoBackend();
  backend = current;
  const view = new MainView({
    window,
    backend: current,
    store,
    settings,
    iface,
    version: config.version,
  });
  window.setContent(view.widget);
  offerUpdate(view);

  const fail = async (message: string) => {
    if (shuttingDown || backend !== current) return;
    backend = null;
    await current.stop().catch(() => {});
    window.setContent(
      errorPage("Monitoring Stopped", message, () => monitor(iface)),
    );
  };
  try {
    await current.start(iface.name, {
      sample: (samples, connections, exited) =>
        store.applySample(samples, connections, exited),
      program: (name) => store.ensure(name),
      failure: (message) => fail(message),
    });
    view.restoreGlobalLimits();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

await eventLoop.start(app);
