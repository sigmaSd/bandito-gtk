import { assertEquals } from "@std/assert";
import { findUpdate, isNewer, latestRelease, parseVersion } from "./updates.ts";

const release = (tag_name: string, extra = {}) => ({
  tag_name,
  html_url: `https://github.com/sigmaSd/bandito-gtk/releases/tag/${tag_name}`,
  ...extra,
});

Deno.test("versions compare by number, not as text", () => {
  assertEquals(isNewer("3.10.0", "3.9.0"), true);
  assertEquals(isNewer("3.2.0", "3.2.0"), false);
  assertEquals(isNewer("3.1.9", "3.2.0"), false);
  assertEquals(isNewer("v4.0.0", "3.2.0"), true);
  assertEquals(parseVersion("build-0460006"), null);
  assertEquals(isNewer("build-0460006", "3.2.0"), false);
});

Deno.test("the latest release skips builds, drafts and prereleases", () => {
  const latest = latestRelease([
    release("build-47b68b2"),
    release("3.4.0", { prerelease: true }),
    release("3.5.0", { draft: true }),
    release("3.2.0"),
    release("3.3.0"),
    release("3.1.3"),
  ]);
  assertEquals(latest?.version, "3.3.0");
});

const answer = (body: unknown, status = 200): typeof fetch => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

Deno.test("an update is a newer release than the running one", async () => {
  const releases = [release("3.2.0"), release("3.3.0")];
  assertEquals((await findUpdate("3.2.0", answer(releases)))?.version, "3.3.0");
  assertEquals(await findUpdate("3.3.0", answer(releases)), null);
});

Deno.test("no answer from GitHub means no update", async () => {
  assertEquals(await findUpdate("3.2.0", answer({}, 403)), null);
  assertEquals(await findUpdate("3.2.0", answer("not a list")), null);
  const offline: typeof fetch = () => Promise.reject(new TypeError("offline"));
  assertEquals(await findUpdate("3.2.0", offline), null);
});
