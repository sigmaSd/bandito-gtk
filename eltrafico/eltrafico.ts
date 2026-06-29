import { getBinaryPath } from "../utils/binary_manager.ts";
import { Unit } from "../interfaces/table.ts";

export interface Program {
  name?: string;
  global?: boolean;
  downloadLimit?: {
    value: number;
    unit: Unit;
  };
  uploadLimit?: {
    value: number;
    unit: Unit;
  };
  downloadMinimum?: {
    value: number;
    unit: Unit;
  };
  uploadMinimum?: {
    value: number;
    unit: Unit;
  };
}

export class ElTrafico {
  #tc: Deno.ChildProcess;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #isClosed = false;

  constructor() {
    const command = new Deno.Command("pkexec", {
      args: [getBinaryPath("eltrafico-tc")],
      stdout: "piped",
      stdin: "piped",
      stderr: "piped",
    });
    const process = command.spawn();
    this.#tc = process;

    this.#reader = process.stdout.getReader();
    this.#writer = process.stdin.getWriter();

    // Consume stderr and filter out the harmless shutdown panic
    (async () => {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let leftOver = "";
      for await (const chunk of process.stderr) {
        const text = decoder.decode(chunk);
        const lines = (leftOver + text).split("\n");
        leftOver = lines.pop() ?? "";

        for (const line of lines) {
          if (
            line.includes("panicked at") ||
            line.includes("note: run with `RUST_BACKTRACE=1`")
          ) continue;
          if (line.trim()) {
            await Deno.stderr.write(encoder.encode(line + "\n"));
          }
        }
      }
      if (leftOver.trim() && !leftOver.includes("panicked at")) {
        await Deno.stderr.write(encoder.encode(leftOver + "\n"));
      }
    })();

    // Handle unexpected exit
    this.#tc.status.then((s) => {
      if (!s.success && !this.#isClosed) {
        console.error("eltrafico-tc process exited with error:", s.code);
        this.#isClosed = true;
      }
    });
  }
  async #read() {
    if (this.#isClosed) return "";
    try {
      const data = await this.#reader.read();
      if (data.done || !data.value) return "";
      return new TextDecoder().decode(data.value);
    } catch (e) {
      console.error("Error reading from eltrafico-tc:", e);
      return "";
    }
  }
  async #write(data: string) {
    if (this.#isClosed) return;
    try {
      await this.#writer.write(
        new TextEncoder().encode(data + "\n"),
      );
    } catch (e) {
      console.error("Error writing to eltrafico-tc:", e);
      this.#isClosed = true;
    }
  }
  async limit(program: Program) {
    const startMsg = program.global ? "Global: " : `Program: ${program.name}`;
    const limitAction = `${startMsg} ${getLimit(program.downloadLimit)} ${
      getLimit(program.uploadLimit)
    } ${getLimit(program.downloadMinimum)} ${getLimit(program.uploadMinimum)}`;

    await this.#write(limitAction);
  }
  async stop() {
    if (this.#isClosed) return;
    try {
      await this.#write("Stop");
      await this.#writer.close();
    } catch {
      // Ignore errors during stop
    } finally {
      this.#isClosed = true;
    }
  }
  async wait() {
    return await this.#tc.status;
  }
  kill() {
    this.#isClosed = true;
    try {
      this.#tc.kill();
    } catch {
      // Ignore
    }
  }
  async interface(name: string) {
    await this.#write(`Interface: ${name}`);
  }
  async poll() {
    const data = await this.#read();

    if (this.#isClosed || data == "Stop") {
      return { stop: true };
    }

    return {
      programs: data.split("\n").filter((l) => l)
        .map((line) => {
          return { name: line.split("ProgramEntry: ")[1] };
        }),
      stop: false,
    };
  }
}

function getLimit(limitAndUnit?: { value: number; unit: Unit }) {
  if (limitAndUnit) {
    return limitAndUnit.value.toString() + limitAndUnit.unit;
  } else {
    return "None";
  }
}
