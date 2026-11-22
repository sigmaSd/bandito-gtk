import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { encodeHex } from "@std/encoding/hex";
import { getFlatpakInstallPath, isFlatpak } from "./flatpak.ts";

const CACHE_DIR = Deno.env.get("XDG_CACHE_HOME")
  ? join(Deno.env.get("XDG_CACHE_HOME")!, "bandito")
  : join(Deno.env.get("HOME")!, ".cache", "bandito");

/** One downloadable build of a helper: the archive and the program in it. */
interface Build {
  url: string;
  /** SHA-256 of the downloaded archive. */
  archiveSha256: string;
  /** Path of the program inside the archive; null when the download is the
   * program itself. */
  member: string | null;
  /** SHA-256 of the program itself, checked again as root before each run. */
  sha256: string;
}

interface Helper {
  binaryName: string;
  /** Whether a copy on the PATH may be run through pkexec. Not for
   * netleash: `cargo install` puts it in a user-writable directory. */
  fromPath: boolean;
  /** Environment variable that points at a program to use instead. */
  envVar: string;
  version: string;
  builds: Partial<Record<typeof Deno.build.arch, Build>>;
}

/**
 * The helper releases Bandito runs as root. Versions and checksums are pinned
 * so a changed or replaced download is never run.
 */
export const HELPERS = {
  "eltrafico-tc": {
    binaryName: "eltrafico-tc",
    fromPath: true,
    envVar: "TC",
    version: "2.3.10",
    builds: {
      x86_64: {
        url:
          "https://github.com/sigmaSd/Eltrafico/releases/download/2.3.10/eltrafico.tar",
        archiveSha256:
          "6e7c7706a2c5680eb3f890840d2f29635e2917ed9daa6475c864577a62a3219a",
        member: "target/release/eltrafico_tc",
        sha256:
          "3c9fb3b8a7af6a74efe7211b71f74139857e91211477405264af50430ab69308",
      },
    },
  },
  "bandwhich": {
    binaryName: "bandwhich",
    fromPath: true,
    envVar: "BANDWHICH",
    version: "v0.23.1",
    builds: {
      x86_64: {
        url:
          "https://github.com/imsnif/bandwhich/releases/download/v0.23.1/bandwhich-v0.23.1-x86_64-unknown-linux-gnu.tar.gz",
        archiveSha256:
          "0de12665fcd1ecafbed84c372fb8edc568bb9eaffee95f53710b8c0b4c687637",
        member: "bandwhich",
        sha256:
          "d18d24df363458669b9a54ff247356e953e55fa78220736b85eee2da2052f0df",
      },
      aarch64: {
        url:
          "https://github.com/imsnif/bandwhich/releases/download/v0.23.1/bandwhich-v0.23.1-aarch64-unknown-linux-gnu.tar.gz",
        archiveSha256:
          "46311a6e2652fc3fc386c1186baa6b986e925c686237434445b656112358ce4d",
        member: "bandwhich",
        sha256:
          "8783c00b09627ec1644d223bddf0874a90dfa4cfad496fb25a7003f7d95006f5",
      },
    },
  },
  // Measures and limits in one: replaces the two above where it has a build.
  "netleash": {
    binaryName: "netleash",
    fromPath: false,
    envVar: "NETLEASH",
    version: "v0.1.0",
    builds: {
      x86_64: {
        url:
          "https://github.com/sigmaSd/netleash/releases/download/v0.1.0/netleash",
        archiveSha256:
          "cfdf3470c2850c092d5919bf2ebdcca7c61757dc307e7e135a94d4b76cef7748",
        member: null,
        sha256:
          "cfdf3470c2850c092d5919bf2ebdcca7c61757dc307e7e135a94d4b76cef7748",
      },
    },
  },
} satisfies Record<string, Helper>;

export type BinaryName = keyof typeof HELPERS;

/** Exit code of the root-side check when a helper doesn't match its pin. */
export const CHECKSUM_FAILED = 125;

/** Root-owned folder holding the checked copies of the helpers. */
export const VERIFIED_DIR = "/var/lib/bandito/helpers";

/**
 * Runs as root through pkexec. Copies the helper into a root-owned folder,
 * checks the copy against its pinned SHA-256 there, then replaces itself with
 * it. Checking the root-owned copy means the file can't be swapped between
 * the check and the run. Older copies of the same helper are removed.
 * Arguments: helper name, helper path, SHA-256, then the helper's own.
 */
export const VERIFY_AND_RUN = `set -eu
name=$1; src=$2; sum=$3; shift 3
dir=${VERIFIED_DIR}
mkdir -p "$dir"; chmod 755 "$dir"
dst="$dir/$name-$sum"
if ! { [ -f "$dst" ] && echo "$sum  $dst" | sha256sum -c --status; }; then
  tmp=$(mktemp "$dir/.new.XXXXXX")
  cat -- "$src" > "$tmp"
  if ! echo "$sum  $tmp" | sha256sum -c --status; then
    rm -f "$tmp"
    echo "bandito: $src does not match its pinned checksum; not running it" >&2
    exit ${CHECKSUM_FAILED}
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$dst"
  for old in "$dir/$name"-*; do
    [ "$old" = "$dst" ] || rm -f "$old"
  done
fi
exec "$dst" "$@"`;

export type ProgressCallback = (status: string, fraction: number) => void;

export interface BinaryState {
  phase: "checking" | "downloading" | "ready" | "failed";
  /** What is happening, e.g. "Downloading bandwhich v0.23.1...". */
  message: string;
  /** Download progress from 0 to 1. */
  fraction: number;
}

async function sha256(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  return encodeHex(await crypto.subtle.digest("SHA-256", data));
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
  const output = await new Deno.Command("tar", {
    args: ["-xf", file, "-C", dest],
  }).output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`The archive could not be extracted.\n${stderr.trim()}`);
  }
}

/** The pinned build for this machine, or an error saying there is none. */
function buildFor(name: BinaryName): Build {
  const helper: Helper = HELPERS[name];
  const build = helper.builds[Deno.build.arch];
  if (!build) {
    throw new Error(
      `No ${name} build for ${Deno.build.arch}. Install ${name} yourself, ` +
        `or set ${helper.envVar} to its path.`,
    );
  }
  return build;
}

/** Download, check and unpack one helper into the cache. */
async function install(name: BinaryName, onProgress: ProgressCallback) {
  const helper: Helper = HELPERS[name];
  const build = buildFor(name);
  const work = await Deno.makeTempDir({ dir: CACHE_DIR, prefix: ".install-" });
  try {
    const archive = join(work, "archive");
    await downloadFile(build.url, archive, (f) => {
      onProgress(`Downloading ${name} ${helper.version}...`, f);
    });
    onProgress(`Checking ${name}...`, 1);
    if (await sha256(archive) !== build.archiveSha256) {
      throw new Error(
        `The ${name} download doesn't match its pinned checksum, so it wasn't installed.`,
      );
    }
    const program = build.member === null ? archive : join(work, build.member);
    if (build.member !== null) await extractTar(archive, work);
    if (await sha256(program) !== build.sha256) {
      throw new Error(
        `The ${name} program doesn't match its pinned checksum, so it wasn't installed.`,
      );
    }
    await Deno.chmod(program, 0o755);
    await Deno.rename(program, join(CACHE_DIR, helper.binaryName));
    // Left by Bandito 3.0.0, which tracked GitHub's latest release.
    await Deno.remove(join(CACHE_DIR, `${helper.binaryName}.version`))
      .catch(() => {});
  } finally {
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

/** Whether a helper is provided outside Bandito's cache. */
async function providedElsewhere(helper: Helper): Promise<string | null> {
  if (Deno.env.get(helper.envVar)) return `Set by ${helper.envVar}`;
  if (!helper.fromPath) return null;
  const output = await new Deno.Command("which", {
    args: [helper.binaryName],
    stdout: "null",
    stderr: "null",
  }).output();
  return output.success ? "Installed" : null;
}

/**
 * Make sure eltrafico-tc and bandwhich are downloaded and match their pinned
 * checksums, reporting each one's progress. Returns one message per binary
 * that failed.
 */
export async function ensureBinaries(
  names: BinaryName[],
  onProgress?: (binary: BinaryName, state: BinaryState) => void,
): Promise<string[]> {
  const report = (binary: BinaryName, state: BinaryState) =>
    onProgress?.(binary, state);
  if (isFlatpak()) {
    for (const name of names) {
      report(name, { phase: "ready", message: "Included", fraction: 1 });
    }
    return [];
  }
  await ensureDir(CACHE_DIR);
  const errors: string[] = [];

  for (const name of names) {
    const helper: Helper = HELPERS[name];
    try {
      const elsewhere = await providedElsewhere(helper);
      if (elsewhere) {
        report(name, { phase: "ready", message: elsewhere, fraction: 1 });
        continue;
      }
      report(name, { phase: "checking", message: "Checking…", fraction: 0 });
      const build = buildFor(name);
      const path = join(CACHE_DIR, helper.binaryName);
      if (!(await exists(path)) || await sha256(path) !== build.sha256) {
        await install(
          name,
          (message, fraction) =>
            report(name, { phase: "downloading", message, fraction }),
        );
      }
      report(name, {
        phase: "ready",
        message: `Version ${helper.version}`,
        fraction: 1,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to install ${name}:`, e);
      errors.push(`${name}: ${msg}`);
      report(name, { phase: "failed", message: msg, fraction: 0 });
    }
  }
  return errors;
}

/**
 * The command that runs a helper as root: through `pkexec`, and from the host
 * when Bandito is a Flatpak. Helpers Bandito downloaded are checked against
 * their pinned checksum as root first; ones set by environment variable,
 * installed on the system or shipped in the Flatpak are run as they are.
 */
export function helperCommand(name: BinaryName, args: string[]): string[] {
  const helper: Helper = HELPERS[name];
  const pkexec = isFlatpak()
    ? ["flatpak-spawn", "--host", "pkexec"]
    : ["pkexec"];

  const envPath = Deno.env.get(helper.envVar);
  if (envPath) return [...pkexec, envPath, ...args];

  const flatpakPath = getFlatpakInstallPath();
  if (flatpakPath) {
    return [...pkexec, `${flatpakPath}/bin/${helper.binaryName}`, ...args];
  }

  const cachePath = join(CACHE_DIR, helper.binaryName);
  const build = helper.builds[Deno.build.arch];
  try {
    if (build && Deno.statSync(cachePath).isFile) {
      return [
        ...pkexec,
        "/bin/sh",
        "-c",
        VERIFY_AND_RUN,
        "bandito-helper",
        name,
        cachePath,
        build.sha256,
        ...args,
      ];
    }
  } catch {
    // Not downloaded; fall back to the system's copy.
  }

  if (!helper.fromPath) throw new Error(`${name} hasn't been downloaded.`);
  return [...pkexec, helper.binaryName, ...args];
}
