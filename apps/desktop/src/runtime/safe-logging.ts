type ErrorStream = {
  on(event: "error", listener: (error: unknown) => void): unknown;
};

export function installBrokenPipeGuards(
  streams: readonly ErrorStream[]
): void {
  for (const stream of streams) {
    stream.on("error", (error: unknown) => {
      if (isBrokenPipeError(error)) {
        return;
      }

      throw error;
    });
  }
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPIPE"
  );
}
