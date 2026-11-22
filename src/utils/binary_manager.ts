import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { encodeHex } from "@std/encoding/hex";
import { isFlatpak } from "./flatpak.ts";

const CACHE_DIR = Deno.env.get("XDG_CACHE_HOME")
  ? join(Deno.env.get("XDG_CACHE_HOME")!, "bandito")
  : join(Deno.env.get("HOME")!, ".cache", "bandito");

/** One downloadable build of a helper. */
interface Build {
  url: string;
  /** SHA-256 of the program, checked after download and again as root
   * before each run. */
  sha256: string;
}

interface Helper {
  binaryName: string;
  /** Environment variable that points at a program to use instead. */
  envVar: string;
  version: string;
  builds: Partial<Record<typeof Deno.build.arch, Build>>;
}

/**
 * The helper Bandito runs as root when netleash has no capabilities of its
 * own. Its version and checksum are pinned so a changed or replaced
 * download is never run.
 */
export const HELPERS = {
  "netleash": {
    binaryName: "netleash",
    envVar: "NETLEASH",
    version: "v0.2.1",
    builds: {
      x86_64: {
        url:
          "https://github.com/sigmaSd/netleash/releases/download/v0.2.1/netleash-x86_64",
        sha256:
          "16db7d7660b99da16f3f340072140bc6a012b5eb32419c5e0deb4e84eb75594b",
      },
      aarch64: {
        url:
          "https://github.com/sigmaSd/netleash/releases/download/v0.2.1/netleash-aarch64",
        sha256:
          "16443991d1bf3f5a504a77557d12c84a7afec29dfb513699f8ab40863f68ecf3",
      },
    },
  },
} satisfies Record<string, Helper>;

export type BinaryName = keyof typeof HELPERS;

/** Exit code of the root-side check when a helper doesn't match its pin. */
export const CHECKSUM_FAILED = 125;

/** Root-owned folder holding the checked copies of the helpers. */
export const VERIFIED_DIR = "/var/lib/bandito/helpers";

/** Quote a value for the shell. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The script pkexec's shell reads on stdin before running a helper. It
 * copies the helper into a root-owned folder, checks the copy against its
 * pinned SHA-256 there, then replaces itself with it, so the file can't be
 * swapped between the check and the run. Older copies are removed. Sent on
 * stdin rather than with `sh -c` so the password prompt shows a short
 * command; the helper then reads the rest of stdin.
 */
export function verifyAndRunScript(
  name: string,
  src: string,
  sum: string,
  dir = VERIFIED_DIR,
): string {
  return `set -eu
name=${shQuote(name)}; src=${shQuote(src)}; sum=${shQuote(sum)}
dir=${shQuote(dir)}
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
exec "$dst"
`;
}

export type ProgressCallback = (status: string, fraction: number) => void;

export interface BinaryState {
  phase: "checking" | "downloading" | "ready" | "failed";
  /** What is happening, e.g. "Downloading netleash v0.2.1...". */
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

/** The pinned build for this machine, or an error saying there is none. */
function buildFor(name: BinaryName): Build {
  const helper: Helper = HELPERS[name];
  const build = helper.builds[Deno.build.arch];
  if (!build) {
    throw new Error(
      `No ${name} build for ${Deno.build.arch} yet. Install ${name} yourself ` +
        `and give it its capabilities, or set ${helper.envVar} to its path.`,
    );
  }
  return build;
}

/** Download and check one helper into the cache. */
async function install(name: BinaryName, onProgress: ProgressCallback) {
  const helper: Helper = HELPERS[name];
  const build = buildFor(name);
  const work = await Deno.makeTempDir({ dir: CACHE_DIR, prefix: ".install-" });
  try {
    const program = join(work, helper.binaryName);
    await downloadFile(build.url, program, (f) => {
      onProgress(`Downloading ${name} ${helper.version}...`, f);
    });
    onProgress(`Checking ${name}...`, 1);
    if (await sha256(program) !== build.sha256) {
      throw new Error(
        `The ${name} download doesn't match its pinned checksum, so it wasn't installed.`,
      );
    }
    await Deno.chmod(program, 0o755);
    await Deno.rename(program, join(CACHE_DIR, helper.binaryName));
  } finally {
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

/**
 * Make sure the helpers are downloaded and match their pinned checksums,
 * reporting each one's progress. Returns one message per helper that failed.
 */
export async function ensureBinaries(
  names: BinaryName[],
  onProgress?: (binary: BinaryName, state: BinaryState) => void,
): Promise<string[]> {
  const report = (binary: BinaryName, state: BinaryState) =>
    onProgress?.(binary, state);
  await ensureDir(CACHE_DIR);
  const errors: string[] = [];

  for (const name of names) {
    const helper: Helper = HELPERS[name];
    try {
      if (Deno.env.get(helper.envVar)) {
        report(name, {
          phase: "ready",
          message: `Set by ${helper.envVar}`,
          fraction: 1,
        });
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

/** How to start a helper as root: the command, and what to send on stdin
 * before anything else. */
export interface Launch {
  command: string[];
  /** The root-side check, for the shell to read first; null for none. */
  script: string | null;
}

/**
 * Run a helper as root through pkexec (from the host when Bandito is a
 * Flatpak; the cache path is the same there). The pinned download is
 * checked as root first. A helper set by its environment variable is run as
 * it is.
 */
export function helperLaunch(name: BinaryName): Launch {
  const helper: Helper = HELPERS[name];
  const pkexec = isFlatpak()
    ? ["flatpak-spawn", "--host", "pkexec"]
    : ["pkexec"];

  const envPath = Deno.env.get(helper.envVar);
  if (envPath) return { command: [...pkexec, envPath], script: null };

  const build = buildFor(name);
  const cachePath = join(CACHE_DIR, helper.binaryName);
  return {
    // Shown in the password prompt as "/bin/sh -s netleash".
    command: [...pkexec, "/bin/sh", "-s", name],
    script: verifyAndRunScript(name, cachePath, build.sha256),
  };
}
