let flatpakInstallPath: string | null | undefined = undefined;

export async function resolveFlatpakInstallPath(): Promise<string | null> {
  if (flatpakInstallPath !== undefined) {
    return flatpakInstallPath;
  }

  const flatpakId = Deno.env.get("FLATPAK_ID");
  if (!flatpakId) {
    flatpakInstallPath = null;
    return null;
  }

  try {
    const cmd = new Deno.Command("flatpak-spawn", {
      args: ["--host", "flatpak", "info", "--show-location", flatpakId],
      stdout: "piped",
      stderr: "piped",
    });

    const output = await cmd.output();
    if (output.success) {
      const path = new TextDecoder().decode(output.stdout).trim();
      flatpakInstallPath = `${path}/files`;
      return flatpakInstallPath;
    }
  } catch {
    // not in flatpak or flatpak-spawn unavailable
  }

  flatpakInstallPath = null;
  return null;
}

export function getFlatpakInstallPath(): string | null {
  if (flatpakInstallPath === undefined) return null;
  return flatpakInstallPath;
}

export function isFlatpak(): boolean {
  return !!Deno.env.get("FLATPAK_ID");
}
