import { Widget } from "@sigmasd/gtk/gtk4";

// jsGTK has no AdwBanner yet, so its few functions are bound here.
const adw = Deno.dlopen("libadwaita-1.so.0", {
  adw_banner_new: { parameters: ["buffer"], result: "pointer" },
  adw_banner_set_title: { parameters: ["pointer", "buffer"], result: "void" },
  adw_banner_set_button_label: {
    parameters: ["pointer", "buffer"],
    result: "void",
  },
  adw_banner_set_revealed: { parameters: ["pointer", "bool"], result: "void" },
});

const cstr = (text: string) => new TextEncoder().encode(text + "\0");

/** AdwBanner: a message under the header bar, with one button. */
export class Banner extends Widget {
  constructor(title: string) {
    super(adw.symbols.adw_banner_new(cstr(title)));
  }

  setTitle(title: string): void {
    adw.symbols.adw_banner_set_title(this.ptr, cstr(title));
  }

  setButtonLabel(label: string): void {
    adw.symbols.adw_banner_set_button_label(this.ptr, cstr(label));
  }

  setRevealed(revealed: boolean): void {
    adw.symbols.adw_banner_set_revealed(this.ptr, revealed);
  }

  onButtonClicked(callback: () => void): number {
    return this.connect("button-clicked", () => callback());
  }
}
