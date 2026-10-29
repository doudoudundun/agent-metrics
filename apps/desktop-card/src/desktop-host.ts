import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DesktopHostReport = {
  ownerPid: number;
  windowHandle: string;
  attached: boolean;
  parentClass: string;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  error: string;
};

export function resolveDesktopHostExecutable(currentDir: string): string {
  const manifest = JSON.parse(readFileSync(join(currentDir, "native", "manifest.json"), "utf8")) as { executable: string };
  if (!/^desktop-host-[a-f0-9]{12}\.exe$/.test(manifest.executable)) throw new Error("Invalid desktop host manifest.");
  return join(currentDir, "native", manifest.executable);
}

export function startDesktopHost(input: {
  executable: string;
  handle: Buffer;
  ownerPid: number;
  onReport: (report: DesktopHostReport) => void;
  onError: (error: Error) => void;
}): { dispose(): void; setBounds(bounds: DesktopHostReport["bounds"]): void } {
  const handle = input.handle.length === 8 ? input.handle.readBigUInt64LE().toString() : input.handle.readUInt32LE().toString();
  const child = spawn(input.executable, [handle, String(input.ownerPid)], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let disposed = false;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line || disposed) continue;
      try {
        const report: unknown = JSON.parse(line);
        if (report && typeof report === "object" && typeof (report as DesktopHostReport).attached === "boolean") {
          input.onReport(report as DesktopHostReport);
        }
      } catch {
        input.onError(new Error("Invalid desktop host response."));
      }
    }
    if (buffer.length > 16_384) buffer = "";
  });
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  child.on("error", (error) => { if (!disposed) input.onError(error); });
  child.on("exit", (code) => {
    if (!disposed && code !== 0) input.onError(new Error(`Desktop host exited: ${code}`));
  });
  return {
    setBounds(bounds) {
      if (disposed || child.stdin.destroyed) return;
      const values = [bounds.x, bounds.y, bounds.width, bounds.height];
      if (!values.every(Number.isFinite)) return;
      child.stdin.write(`bounds ${values.map(Math.round).join(" ")}\n`);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      child.stdout.removeAllListeners("data");
      if (child.exitCode === null) child.kill();
    }
  };
}
