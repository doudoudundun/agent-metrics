import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTimelinePanel } from "./SessionTimelinePanel";

describe("SessionTimelinePanel", () => {
  it("paginates long session timelines", () => {
    render(
      <SessionTimelinePanel
        detail={{
          sessionId: "ses_1",
          timeline: Array.from({ length: 12 }, (_, index) => ({
            type: `tool.event.${index}`,
            toolName: `Tool ${index}`,
            status: "succeeded",
            durationMs: index,
            filesChanged: [],
            insertions: 0,
            deletions: 0
          }))
        }}
      />
    );

    expect(screen.getByText("tool.event.0")).toBeInTheDocument();
    expect(screen.queryByText("tool.event.10")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));

    expect(screen.getByText("tool.event.10")).toBeInTheDocument();
    expect(screen.queryByText("tool.event.0")).not.toBeInTheDocument();
  });
});
