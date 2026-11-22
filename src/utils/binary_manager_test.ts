import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import {
  CHECKSUM_FAILED,
  HELPERS,
  VERIFIED_DIR,
  VERIFY_AND_RUN,
} from "./binary_manager.ts";

/** The root-side check, pointed at a test folder instead of /var/lib. */
async function verifyAndRun(
  root: string,
  program: string,
  sum: string,
  args: string[],
  stdin = "",
) {
  const script = VERIFY_AND_RUN.replace(VERIFIED_DIR, root);
  const child = new Deno.Command("/bin/sh", {
    args: ["-c", script, "bandito-helper", "helper", program, sum, ...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const output = await child.output();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  return {
    code: output.code,
    stdout: decode(output.stdout),
    stderr: decode(output.stderr),
  };
}

async function writeProgram(path: string, body: string): Promise<string> {
  const text = `#!/bin/sh\n${body}\n`;
  await Deno.writeTextFile(path, text);
  await Deno.chmod(path, 0o755);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return encodeHex(digest);
}

Deno.test("verified helper runs with its arguments and stdin", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const program = join(dir, "helper");
    const sum = await writeProgram(program, 'echo "args: $*"; cat');
    const result = await verifyAndRun(
      join(dir, "run"),
      program,
      sum,
      ["-i", "wlan0"],
      "Stop\n",
    );
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "args: -i wlan0\nStop\n");
    // It runs the checked copy, not the file in the cache.
    assertEquals(
      (await Deno.stat(join(dir, "run", `helper-${sum}`))).isFile,
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a changed helper is refused and not run", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const program = join(dir, "helper");
    const sum = await writeProgram(program, "echo original");
    await writeProgram(program, "echo replaced");
    const result = await verifyAndRun(join(dir, "run"), program, sum, []);
    assertEquals(result.code, CHECKSUM_FAILED);
    assertEquals(result.stdout, "");
    assertStringIncludes(result.stderr, "does not match its pinned checksum");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a damaged checked copy is replaced before running", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const run = join(dir, "run");
    const program = join(dir, "helper");
    const sum = await writeProgram(program, "echo original");
    await verifyAndRun(run, program, sum, []);
    await Deno.writeTextFile(
      join(run, `helper-${sum}`),
      "#!/bin/sh\necho damaged\n",
    );
    const result = await verifyAndRun(run, program, sum, []);
    assertEquals(result.stdout, "original\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an updated helper replaces its older copy", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const run = join(dir, "run");
    const program = join(dir, "helper");
    const first = await writeProgram(program, "echo first");
    await verifyAndRun(run, program, first, []);
    const second = await writeProgram(program, "echo second");
    const result = await verifyAndRun(run, program, second, []);
    assertEquals(result.stdout, "second\n");
    const names = [...Deno.readDirSync(run)].map((e) => e.name);
    assertEquals(names, [`helper-${second}`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every pinned build has well-formed checksums", () => {
  for (const helper of Object.values(HELPERS)) {
    for (const build of Object.values(helper.builds)) {
      assertEquals(/^[0-9a-f]{64}$/.test(build.sha256), true);
      assertEquals(/^[0-9a-f]{64}$/.test(build.archiveSha256), true);
      assertStringIncludes(build.url, `/${helper.version}/`);
    }
  }
});
