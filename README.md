# Bandito GTK

A modern, GTK4-based bandwidth monitor and traffic shaper for Linux.

Bandito GTK allows you to monitor network traffic per application and apply
bandwidth limits (download and upload) using `eltrafico-tc` and `bandwhich` as
backends.

![Bandito showing per-app download and upload rates, with limits on Steam and Syncthing](distro/screenshots/main.png)

![The limit panel for Steam, with a 2.5 MB/s download limit and its connections](distro/screenshots/limits.png)

## Features

- **Real-time Monitoring:** Total download and upload with a one-minute chart,
  and a 30-second history for every app. Busy apps sort to the top; quiet ones
  fold into an Idle group.
- **Traffic Shaping:** Limit download and upload separately, per app or for all
  apps at once, from a side panel with presets. Every change can be undone.
- **Remembered Limits:** Limits are saved per app and applied again on start.
- **Connections:** Each app's panel lists the hosts it talked to in the last
  minute, with the service, port and rates. Traffic that can't be matched to a
  program is shown with its connections and the likely reasons.
- **Readable Units:** Rates and limits share one unit (KB/s and MB/s, or bits
  from the menu).
- **Modern UI:** Built with GTK4 and libadwaita, with real app names and icons
  from your installed applications.
- **Automatic Dependencies:** Automatically downloads and caches required
  binaries (`eltrafico-tc`, `bandwhich`) in your XDG cache directory.
- **Network Switching:** Pick the network on first run and switch from the
  header bar at any time.

## Installation

### Binary

You can download the latest pre-compiled binary from the
[Releases](https://github.com/sigmaSd/bandito-gtk/releases) page.

Once downloaded, make the binary executable:

```bash
chmod +x bandito-gtk
```

### Flatpak

You can install via Flatpak from the
[Releases](https://github.com/sigmaSd/bandito-gtk/releases) page (build-*
releases). Download the `.flatpak` file for your architecture and install:

```bash
flatpak install --user bandito-gtk-<arch>.flatpak
```

## Usage

Run the application:

```bash
./bandito-gtk
```

If no interface is specified as an argument, a selection window will appear. You
can also specify the interface directly:

```bash
./bandito-gtk wlan0
```

## Development

Requires [Deno](https://deno.land/).

```bash
deno run -A src/main.ts [interface]
```

To try the interface without root, downloads or network traffic, run it with
simulated data:

```bash
BANDITO_DEMO=1 deno run -A src/main.ts
```

Settings and saved limits live in `$XDG_CONFIG_HOME/bandito/settings.json`.

## Dependencies

The application relies on:

- [netleash](https://github.com/sigmaSd/netleash) measures and limits traffic on
  x86_64. Bandito downloads a pinned release, checks its SHA-256, and runs a
  checked root-owned copy (in `/var/lib/bandito/helpers`) through `pkexec`, so
  you're asked for your password when monitoring starts. To skip the prompt,
  install netleash yourself and give it its capabilities once;
  Bandito then runs it as you:

  ```sh
  cargo install netleash
  sudo setcap cap_bpf,cap_net_admin,cap_perfmon+ep ~/.cargo/bin/netleash
  ```

- Elsewhere (aarch64, the Flatpak), Bandito uses two older helpers instead,
  `eltrafico-tc` 2.3.10 and `bandwhich` 0.23.1, downloaded and checked the same
  way. `BANDITO_BACKEND=legacy` picks them on x86_64 too.
- `pkexec` (for root privileges when measuring and shaping traffic)

Bandito downloads exact versions of its helpers and checks their SHA-256
checksums. Before each run, a short root script copies the helper into
`/var/lib/bandito/helpers`, checks the copy and runs it, so a changed file in
`~/.cache/bandito` is never run as root. Because of this, the password prompt
names `/bin/sh`. To use your own builds, install them on your `PATH`, or set
`TC` and `BANDWHICH` to their paths; those are run as they are.

- GTK4 libraries
