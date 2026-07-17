import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installBrokenPipeGuards } from "./safe-logging.js";

function createErrorStream(): EventEmitter {
  return new EventEmitter();
}

describe("safe logging", () => {
  it("ignores broken-pipe errors from stdout and stderr", () => {
    const stdout = createErrorStream();
    const stderr = createErrorStream();

    installBrokenPipeGuards([stdout, stderr]);

    expect(() => {
      stdout.emit("error", { code: "EPIPE" });
      stderr.emit("error", { code: "EPIPE" });
    }).not.toThrow();
  });

  it("does not hide other stream errors", () => {
    const stream = createErrorStream();
    const error = new Error("stream failed");

    installBrokenPipeGuards([stream]);

    expect(() => stream.emit("error", error)).toThrow(error);
  });
});
