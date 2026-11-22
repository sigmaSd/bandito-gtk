import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { getFlatpakInstallPath, isFlatpak } from "./flatpak.ts";

const CACHE_DIR = Deno.env.get("XDG_CACHE_HOME")
  ? join(Deno.env.get("XDG_CACHE_HOME")!, "bandito")
  : join(Deno.env.get("HOME")!, ".cache", "bandito");

const BINARIES = {
  "eltrafico-tc": {
    repo: "sigmaSd/Eltrafico",
    binaryName: "eltrafico-tc",
    envVar: "TC",
  },
  "bandwhich": {
    repo: "imsnif/bandwhich",
    binaryName: "bandwhich",
    envVar: "BANDWHICH",
  },
};

interface ReleaseInfo {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

export type ProgressCallback = (status: string, fraction: number) => void;

async function getLatestRelease(repo: string): Promise<ReleaseInfo> {
  const ghCommand = new Deno.Command("gh", {
    args: ["api", `repos/${repo}/releases/latest`],
    stdout: "piped",
    stderr: "piped",
  });
  const ghOutput = await ghCommand.output();
  if (ghOutput.success) {
    return JSON.parse(new TextDecoder().decode(ghOutput.stdout));
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
  );
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        `GitHub API rate limit exceeded. Run "gh auth login" or set GITHUB_TOKEN, or try again later.`,
      );
    }
    throw new Error(
      `Failed to fetch release info for ${repo}: ${response.statusText}`,
    );
  }
  return await response.json();
}

async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (fraction: number) => void,
) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  const file = await Deno.open(dest, {
    create: true,
    write: true,
    truncate: true,
  });

  if (!response.body) {
    file.close();
    throw new Error(`No response body for ${url}`);
  }

  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        loaded += value.length;
        if (total > 0 && onProgress) {
          onProgress(loaded / total);
        }
        await file.write(value);
      }
    }
    if (total > 0 && loaded !== total) {
      throw new Error(`Download incomplete: ${loaded}/${total} bytes`);
    }
  } finally {
    file.sync();
    file.close();
  }
}

async function extractTar(file: string, dest: string) {
  const cmd = new Deno.Command("tar", {
    args: ["-xf", file, "-C", dest],
  });
  const output = await cmd.output();
  if (!output.success) {
    await Deno.remove(file).catch(() => {});
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(
      `Corrupted download — archive could not be extracted. Delete ~/.cache/bandito and try again.\n${stderr.trim()}`,
    );
  }
}

async function installEltraficoTc(
  version: string,
  onProgress?: ProgressCallback,
) {
  if (onProgress) onProgress(`Fetching info for eltrafico-tc...`, 0);
  const info = await getLatestRelease(BINARIES["eltrafico-tc"].repo);
  const asset = info.assets.find((a) => a.name === "eltrafico.tar");
  if (!asset) throw new Error("Could not find eltrafico.tar");

  const tarPath = join(CACHE_DIR, "eltrafico.tar");
  await downloadFile(asset.browser_download_url, tarPath, (f) => {
    if (onProgress) {
      onProgress(`Downloading eltrafico-tc ${version}...`, f);
    }
  });

  if (onProgress) onProgress(`Extracting eltrafico-tc...`, 1);
  await extractTar(tarPath, CACHE_DIR);

  const extractedPath = join(CACHE_DIR, "target/release/eltrafico_tc");
  const finalPath = join(CACHE_DIR, "eltrafico-tc");

  await Deno.rename(extractedPath, finalPath);
  await Deno.chmod(finalPath, 0o755);

  await Deno.remove(tarPath);
  try {
    await Deno.remove(join(CACHE_DIR, "target"), { recursive: true });
  } catch {
    // ignore
  }

  await Deno.writeTextFile(join(CACHE_DIR, "eltrafico-tc.version"), version);
}

async function installBandwhich(
  version: string,
  onProgress?: ProgressCallback,
) {
  if (onProgress) onProgress(`Fetching info for bandwhich...`, 0);
  const info = await getLatestRelease(BINARIES["bandwhich"].repo);
  const asset = info.assets.find(
    (a) => a.name.includes("unknown-linux-gnu") && a.name.includes("x86_64"),
  );
  if (!asset) throw new Error("Could not find suitable bandwhich binary");

  const tarPath = join(CACHE_DIR, "bandwhich.tar.gz");
  await downloadFile(asset.browser_download_url, tarPath, (f) => {
    if (onProgress) {
      onProgress(`Downloading bandwhich ${version}...`, f);
    }
  });

  if (onProgress) onProgress(`Extracting bandwhich...`, 1);
  await extractTar(tarPath, CACHE_DIR);

  const finalPath = join(CACHE_DIR, "bandwhich");
  await Deno.chmod(finalPath, 0o755);
  await Deno.remove(tarPath);
  await Deno.writeTextFile(join(CACHE_DIR, "bandwhich.version"), version);
}

export async function checkMissingBinaries(): Promise<boolean> {
  if (isFlatpak()) return false;
  await ensureDir(CACHE_DIR);
  let missing = false;
  for (const [_key, config] of Object.entries(BINARIES)) {
    const finalPath = join(CACHE_DIR, config.binaryName);

    if (Deno.env.get(config.envVar)) continue;

    const command = new Deno.Command("which", { args: [config.binaryName] });
    const output = await command.output();
    if (output.success) continue;

    const versionFile = join(CACHE_DIR, `${config.binaryName}.version`);
    const currentVersion = await exists(versionFile)
      ? await Deno.readTextFile(versionFile)
      : null;

    try {
      const info = await getLatestRelease(config.repo);
      if (currentVersion !== info.tag_name || !(await exists(finalPath))) {
        missing = true;
      }
    } catch {
      if (!(await exists(finalPath))) missing = true;
    }
  }
  return missing;
}

export type BinaryName = keyof typeof BINARIES;

export interface BinaryState {
  phase: "checking" | "downloading" | "ready" | "failed";
  /** What is happening, e.g. "Downloading bandwhich v0.23.1...". */
  message: string;
  /** Download progress from 0 to 1. */
  fraction: number;
}

/**
 * Make sure eltrafico-tc and bandwhich are installed and current, reporting
 * each one's progress. Returns one message per binary that failed.
 */
export async function ensureBinaries(
  onProgress?: (binary: BinaryName, state: BinaryState) => void,
): Promise<string[]> {
  const report = (binary: BinaryName, state: BinaryState) =>
    onProgress?.(binary, state);
  const names = Object.keys(BINARIES) as BinaryName[];
  if (isFlatpak()) {
    for (const name of names) {
      report(name, { phase: "ready", message: "Included", fraction: 1 });
    }
    return [];
  }
  await ensureDir(CACHE_DIR);
  const errors: string[] = [];

  for (const name of names) {
    const config = BINARIES[name];
    const finalPath = join(CACHE_DIR, config.binaryName);

    if (Deno.env.get(config.envVar)) {
      report(name, {
        phase: "ready",
        message: "Set by " + config.envVar,
        fraction: 1,
      });
      continue;
    }

    const command = new Deno.Command("which", { args: [config.binaryName] });
    const output = await command.output();
    if (output.success) {
      report(name, { phase: "ready", message: "Installed", fraction: 1 });
      continue;
    }

    try {
      const versionFile = join(CACHE_DIR, `${config.binaryName}.version`);
      const currentVersion = await exists(versionFile)
        ? (await Deno.readTextFile(versionFile)).trim()
        : null;

      report(name, {
        phase: "checking",
        message: "Checking for updates…",
        fraction: 0,
      });
      let info: ReleaseInfo | null = null;
      try {
        info = await getLatestRelease(config.repo);
      } catch (e) {
        // Offline is fine when a copy is already downloaded.
        if (!(await exists(finalPath))) throw e;
      }

      if (
        info && (currentVersion !== info.tag_name || !(await exists(finalPath)))
      ) {
        const progress: ProgressCallback = (message, fraction) =>
          report(name, { phase: "downloading", message, fraction });
        if (name === "eltrafico-tc") {
          await installEltraficoTc(info.tag_name, progress);
        } else {
          await installBandwhich(info.tag_name, progress);
        }
      }
      const version = info?.tag_name ?? currentVersion;
      report(name, {
        phase: "ready",
        message: version ? `Version ${version}` : "Downloaded",
        fraction: 1,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to update/install ${name}:`, e);
      errors.push(`${name}: ${msg}`);
      report(name, { phase: "failed", message: msg, fraction: 0 });
    }
  }
  return errors;
}

export function getBinaryPath(name: "eltrafico-tc" | "bandwhich"): string {
  const config = BINARIES[name];
  const envPath = Deno.env.get(config.envVar);
  if (envPath) return envPath;

  const flatpakPath = getFlatpakInstallPath();
  if (flatpakPath) {
    return `${flatpakPath}/bin/${config.binaryName}`;
  }

  const cachePath = join(CACHE_DIR, config.binaryName);
  try {
    const stat = Deno.statSync(cachePath);
    if (stat.isFile) return cachePath;
  } catch {
    // ignore
  }

  return config.binaryName;
}
