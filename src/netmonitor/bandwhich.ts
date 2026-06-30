import { TextDelimiterStream } from "@std/streams";
import { getBinaryPath } from "../utils/binary_manager.ts";
import { isFlatpak } from "../utils/flatpak.ts";

export async function* bandwhich(interfaceName: string) {
  const [command, ...args] = isFlatpak()
    ? [
      "flatpak-spawn",
      "--host",
      "pkexec",
      getBinaryPath("bandwhich"),
      "-p",
      "--raw",
      "-i",
      interfaceName,
    ]
    : [
      "pkexec",
      getBinaryPath("bandwhich"),
      "-p",
      "--raw",
      "-i",
      interfaceName,
    ];
  const denoCommand = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const process = denoCommand.spawn();
  let isExited = false;

  (async () => {
    for await (const chunk of process.stderr) {
      if (!isExited) {
        await Deno.stderr.write(chunk);
      }
    }
  })();

  process.status.then((s) => {
    if (!s.success) {
      if (s.code !== 143 && s.code !== 130) {
        console.error("bandwhich exited with error:", s.code);
      }
    }
    isExited = true;
  });

  const bandwhichStream = process.stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TextDelimiterStream("\n\n"),
    );

  try {
    for await (const data of bandwhichStream) {
      if (isExited) break;
      yield parse(data);
    }
  } catch (e) {
    console.error("bandwhich stream error:", e);
  }
}

function parse(data: string) {
  return data.split("\n").slice(1).map((line) => {
    if (line === "<NO TRAFFIC>" || !line.trim()) {
      return;
    }
    const lineParts = line.split(/\s+/);
    if (lineParts.length < 6) return;

    const name = lineParts[2].slice(1, -1);
    const netRate = lineParts[5];

    const uploadRate = parseFloat(netRate.split("/")[0]);
    const downloadRate = parseFloat(netRate.split("/")[1]);
    return {
      name,
      downloadRate,
      uploadRate,
    };
  }).filter((e) => e) as {
    name: string;
    downloadRate: number;
    uploadRate: number;
  }[];
}
