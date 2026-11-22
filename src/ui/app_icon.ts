import {
  Align,
  Box,
  Display,
  IconTheme,
  Image,
  Label,
  Orientation,
  type Widget,
} from "@sigmasd/gtk/gtk4";
import type { Identity } from "../model/identity.ts";

let theme: IconTheme | null | undefined;

function themedName(names: string[]): string | null {
  if (theme === undefined) {
    const display = Display.getDefault();
    theme = display ? IconTheme.getForDisplay(display) : null;
  }
  return names.find((n) => theme?.hasIcon(n)) ?? null;
}

function hash(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** The app's own icon, or a coloured tile with its initial. */
export function appIcon(
  name: string,
  identity: Identity,
  size: number,
): Widget {
  const icon = identity.icon;
  if (icon?.kind === "file") {
    const image = new Image({ file: icon.path });
    image.setPixelSize(size);
    return image;
  }
  if (icon?.kind === "themed") {
    const themed = themedName(icon.names);
    if (themed) {
      const image = new Image({ iconName: themed });
      image.setPixelSize(size);
      return image;
    }
  }
  const tile = new Box(Orientation.VERTICAL, 0);
  tile.setSizeRequest(size, size);
  tile.setValign(Align.CENTER);
  tile.setHalign(Align.CENTER);
  tile.addCssClass("app-tile");
  // Fixed size: don't let the centred child's expand flag grow the tile.
  tile.setVexpand(false);
  tile.setHexpand(false);
  if (!identity.limitable) {
    tile.addCssClass("unknown");
    const image = new Image({ iconName: "dialog-question-symbolic" });
    image.setVexpand(true);
    tile.append(image);
    return tile;
  }
  tile.addCssClass(`tile-${hash(name) % 6}`);
  const letter = new Label(identity.title.charAt(0).toUpperCase() || "?");
  letter.setVexpand(true);
  tile.append(letter);
  return tile;
}
