// The download buttons: the files of the latest release, asked of GitHub's API by the visitor's browser, so
// the site never needs updating for a release. Without an answer (offline, rate-limited), the page's own
// link to the release page stays.
//
// The binaries are on the versioned release (3.1.3); the Flatpaks are on the build release of the same
// commit (build-<sha>), which release.yml publishes.

const REPO = "sigmaSd/bandito-gtk";
const API = `https://api.github.com/repos/${REPO}`;
const DOWNLOAD = `https://github.com/${REPO}/releases/download/`;

const ARCHES = [
  { id: "x86_64", deb: "amd64", name: "Intel and AMD", hint: "x86_64: most computers." },
  { id: "aarch64", deb: "arm64", name: "64-bit ARM", hint: "aarch64: ARM laptops and boards." },
];

async function api(path, accept = "application/vnd.github+json") {
  const res = await fetch(API + path, { headers: { Accept: accept } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return accept.endsWith("json") ? res.json() : res.text();
}

const ours = (release) => (release.assets ?? []).filter((a) => String(a.browser_download_url).startsWith(DOWNLOAD));

async function flatpaks(tag) {
  try {
    const sha = (await api(`/commits/${encodeURIComponent(tag)}`, "application/vnd.github.sha")).trim();
    return ours(await api(`/releases/tags/build-${sha}`));
  } catch {
    return []; // not built yet: the binaries are still offered
  }
}

function el(tag, props, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function button(asset, label, secondary) {
  const size = `${Math.round(asset.size / 1e6)} MB`;
  return el(
    "a",
    { className: `button${secondary ? " secondary" : ""}`, href: asset.browser_download_url },
    label,
    el("span", { className: "size" }, size),
  );
}

async function main() {
  const release = await api("/releases/latest");
  const files = [...ours(release), ...(await flatpaks(release.tag_name))];
  const blocks = [];
  for (const arch of ARCHES) {
    // Packages first: they add the menu entry and icon, and bring netleash.
    const rpm = files.find((a) => a.name.startsWith("bandito-gtk-") && a.name.endsWith(`.${arch.id}.rpm`));
    const deb = files.find((a) => a.name.startsWith("bandito-gtk_") && a.name.endsWith(`_${arch.deb}.deb`));
    const flatpak = files.find((a) => a.name === `bandito-gtk-${arch.id}.flatpak`);
    const binary = files.find((a) => a.name === `bandito-gtk-${arch.id}`);
    const links = [];
    for (const [asset, label] of [
      [rpm, "Fedora (.rpm)"],
      [deb, "Ubuntu, Debian (.deb)"],
      [flatpak, "Flatpak"],
      [binary, "Binary"],
    ]) {
      if (asset) links.push(button(asset, label, links.length > 0));
    }
    if (!links.length) continue;
    blocks.push(
      el(
        "div",
        { className: "platform" },
        el("h3", {}, arch.name),
        el("div", { className: "buttons" }, ...links),
        el("p", { className: "fine" }, arch.hint),
      ),
    );
  }
  if (!blocks.length) return;
  blocks.push(
    el("p", { className: "fine" }, `Version ${release.tag_name}. `, el("a", { href: release.html_url }, "What's new")),
  );
  document.getElementById("downloads").replaceChildren(...blocks);
}

main().catch(() => {});
