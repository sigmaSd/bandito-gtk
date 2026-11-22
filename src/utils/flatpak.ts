/** Whether Bandito runs inside a Flatpak sandbox. */
export function isFlatpak(): boolean {
  return !!Deno.env.get("FLATPAK_ID");
}
