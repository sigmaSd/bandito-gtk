# Bandito GTK

A modern, GTK4-based bandwidth monitor and traffic shaper for Linux.

Bandito GTK allows you to monitor network traffic per application and apply
bandwidth limits (download and upload) using `eltrafico-tc` and `bandwhich` as
backends.

## Features

- **Real-time Monitoring:** Track download and upload rates for all running
  applications.
- **Traffic Shaping:** Apply precise bandwidth limits to specific programs or
  globally.
- **Modern UI:** Built with GTK4 and Adwaita for a native Linux look and feel.
- **Automatic Dependencies:** Automatically downloads and caches required
  binaries (`eltrafico-tc`, `bandwhich`) in your XDG cache directory.
- **Interface Selection:** Easy-to-use GUI for selecting the network interface.

## Installation

You can download the latest pre-compiled binary from the
[Releases](https://github.com/sigmaSd/bandito-gtk/releases) page.

Once downloaded, make the binary executable:

```bash
chmod +x bandito-gtk
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
deno run -A main.ts [interface]
```

## Dependencies

The application relies on:

- `pkexec` (for root privileges when shaping traffic)
- `eltrafico-tc` (automatically downloaded)
- `bandwhich` (automatically downloaded)
- GTK4 libraries
