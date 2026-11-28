/**
 * Whether a newer Bandito is released: asks GitHub's API for the
 * repository's releases once per start, when the user lets it.
 */

export const RELEASES_API =
  "https://api.github.com/repos/sigmaSd/bandito-gtk/releases?per_page=30";

/** A released version and its release page. */
export interface Release {
  version: string;
  url: string;
}

/** The fields of a GitHub release this reads. */
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** `3.2.0` or `v3.2.0` as numbers; null for anything else, like build-<sha>. */
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `a` is a later version than `b`. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/** The latest versioned release, skipping drafts, prereleases and builds. */
export function latestRelease(releases: GitHubRelease[]): Release | null {
  let latest: Release | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !parseVersion(r.tag_name)) continue;
    if (!latest || isNewer(r.tag_name, latest.version)) {
      latest = { version: r.tag_name.replace(/^v/, ""), url: r.html_url };
    }
  }
  return latest;
}

/** A release newer than `current`, or null when there is none or GitHub didn't answer. */
export async function findUpdate(
  current: string,
  fetcher: typeof fetch = fetch,
): Promise<Release | null> {
  try {
    const response = await fetcher(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "bandito-gtk",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const latest = latestRelease(await response.json());
    return latest && isNewer(latest.version, current) ? latest : null;
  } catch {
    return null;
  }
}
