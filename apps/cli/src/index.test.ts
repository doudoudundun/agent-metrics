import { describe, expect, it } from "vitest";
import { buildProgram } from "./index.js";

describe("buildProgram", () => {
  it("registers hooks commands and drops the wrapper entrypoint", () => {
    const program = buildProgram();
    const topLevel = program.commands.map((command) => command.name());
    const hooks = program.commands.find((command) => command.name() === "hooks");

    expect(topLevel).toEqual(["hooks"]);
    expect(topLevel).toContain("hooks");
    expect(topLevel).not.toContain("wrap");
    expect(hooks?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["collect", "ensure", "install", "print-config", "parse", "watch"])
    );
  });
});
