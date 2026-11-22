import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import {
  CHECKSUM_FAILED,
  HELPERS,
  verifyAndRunScript,
} from "./binary_manager.ts";

const SHELL = Deno.env.get("TEST_SHELL") ?? "/bin/sh";

/**
 * Run the root-side check the way pkexec does, `sh -s name` with the script
 * on stdin, pointed at a test folder instead of /var/lib. Once the helper
 * prints its first line, `after` is written to its stdin, as Bandito sends
 * commands only after netleash says it's ready.
 */
async function verifyAndRun(
  dir: string,
  program: string,
  sum: string,
  after = "",
) {
  const child = new Deno.Command(SHELL, {
    args: ["-s", "helper"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const encoder = new TextEncoder();
  await writer.write(
    encoder.encode(verifyAndRunScript("helper", program, sum, dir)),
  );
  const reader = child.stdout.getReader();
  let stdout = "";
  const first = await reader.read();
  if (!first.done) {
    stdout += new TextDecoder().decode(first.value);
    await writer.write(encoder.encode(after));
  }
  await writer.close();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    stdout += new TextDecoder().decode(value);
  }
  const status = await child.status;
  const stderr = new TextDecoder().decode(
    (await new Response(child.stderr).arrayBuffer()) as ArrayBuffer,
  );
  return { code: status.code, stdout, stderr };
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

Deno.test("the checked helper gets the stdin sent after it starts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const program = join(dir, "helper");
    const sum = await writeProgram(program, "echo ready; cat");
    const result = await verifyAndRun(join(dir, "run"), program, sum, "Stop\n");
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "ready\nStop\n");
    // It runs the checked copy, not the file in the cache.
    assertEquals(
      (await Deno.stat(join(dir, "run", `helper-${sum}`))).isFile,
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("paths with spaces and quotes are passed intact", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const program = join(dir, "it's a helper");
    const sum = await writeProgram(program, "echo ran");
    const result = await verifyAndRun(join(dir, "run dir"), program, sum);
    assertEquals(result.stdout, "ran\n");
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
    const result = await verifyAndRun(join(dir, "run"), program, sum);
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
    await verifyAndRun(run, program, sum);
    await Deno.writeTextFile(
      join(run, `helper-${sum}`),
      "#!/bin/sh\necho damaged\n",
    );
    const result = await verifyAndRun(run, program, sum);
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
    await verifyAndRun(run, program, first);
    const second = await writeProgram(program, "echo second");
    const result = await verifyAndRun(run, program, second);
    assertEquals(result.stdout, "second\n");
    const names = [...Deno.readDirSync(run)].map((e) => e.name);
    assertEquals(names, [`helper-${second}`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every pinned build has a well-formed checksum", () => {
  for (const helper of Object.values(HELPERS)) {
    for (const build of Object.values(helper.builds)) {
      assertEquals(/^[0-9a-f]{64}$/.test(build.sha256), true);
      assertStringIncludes(build.url, `/${helper.version}/`);
    }
  }
});
