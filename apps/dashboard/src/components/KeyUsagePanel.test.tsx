import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyUsageResponse } from "@agent-metrics/contracts";
import { KeyUsagePanel } from "./KeyUsagePanel";

afterEach(() => {
  cleanup();
});

const NOW = new Date("2026-10-10T09:00:00.000Z");

function buildResponse(): KeyUsageResponse {
  return {
    updatedAt: "2026-10-10T08:55:00.000Z",
    entries: [
      {
        vendor: "codex",
        source: "codex-rollout",
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 44.5,
          windowMinutes: 300,
          resetsAt: "2026-10-10T12:20:00.000Z"
        },
        secondary: {
          usedPercent: 41,
          windowMinutes: 10080,
          resetsAt: "2026-10-15T01:19:16.000Z"
        },
        credits: { hasCredits: false, unlimited: false }
      }
    ]
  };
}

describe("KeyUsagePanel", () => {
  it("renders quota percentages, window lengths, reset countdowns, and credit state", () => {
    render(<KeyUsagePanel data={buildResponse()} now={NOW} />);

    expect(screen.getByRole("heading", { name: "Key usage & limits" })).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("44.5%")).toBeInTheDocument();

    const primaryBar = screen.getByRole("progressbar", { name: "Primary window quota used" });
    expect(primaryBar).toHaveAttribute("aria-valuenow", "45");
    expect(primaryBar).toHaveAttribute("aria-valuemin", "0");
    expect(primaryBar).toHaveAttribute("aria-valuemax", "100");

    expect(screen.getByText(/5h window/)).toBeInTheDocument();
    expect(screen.getByText(/7d window/)).toBeInTheDocument();
    expect(screen.getByText(/Resets in 3h 20m/)).toBeInTheDocument();
    expect(screen.getByText(/Resets in 4d 16h/)).toBeInTheDocument();

    const credits = screen.getByText("No extra credits");
    expect(credits).toHaveAttribute("data-state", "none");
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it("marks a window whose reset time already passed as expired", () => {
    render(
      <KeyUsagePanel
        now={NOW}
        data={{
          updatedAt: "2026-10-10T08:55:00.000Z",
          entries: [
            {
              vendor: "codex",
              source: "codex-rollout",
              limitId: "codex",
              limitName: "Primary plan",
              primary: { usedPercent: 100, windowMinutes: 300, resetsAt: "2026-10-10T08:00:00.000Z" },
              secondary: null,
              credits: { hasCredits: true, unlimited: true }
            }
          ]
        }}
      />
    );

    expect(screen.getByText(/Window expired/)).toBeInTheDocument();
    expect(screen.queryByText(/Resets in/)).not.toBeInTheDocument();
    expect(screen.getByText("Primary plan")).toBeInTheDocument();
    const credits = screen.getByText("Unlimited credits");
    expect(credits).toHaveAttribute("data-state", "unlimited");
    expect(screen.getByRole("progressbar", { name: "Primary window quota used" })).toHaveAttribute(
      "aria-valuenow",
      "100"
    );
  });

  it("falls back to unknown labels when quota fields are missing", () => {
    render(
      <KeyUsagePanel
        now={NOW}
        data={{
          updatedAt: null,
          entries: [
            {
              vendor: "codex",
              source: "codex-rollout",
              limitId: null,
              limitName: null,
              primary: null,
              secondary: null,
              credits: null
            }
          ]
        }}
      />
    );

    expect(screen.getByText("Default limit")).toBeInTheDocument();
    expect(screen.getByText("No quota windows reported.")).toBeInTheDocument();
    expect(screen.getByText("Credits unknown")).toBeInTheDocument();
    expect(screen.getByText("Synced from local rollout logs")).toBeInTheDocument();
  });

  it("renders a friendly empty state before any snapshot exists", () => {
    const { rerender } = render(<KeyUsagePanel data={null} now={NOW} />);
    expect(screen.getByText("No official key usage data yet.")).toBeInTheDocument();

    rerender(<KeyUsagePanel data={{ updatedAt: null, entries: [] }} now={NOW} />);
    expect(screen.getByText("No official key usage data yet.")).toBeInTheDocument();

    rerender(<KeyUsagePanel now={NOW} />);
    expect(screen.getByText("No official key usage data yet.")).toBeInTheDocument();
  });

  it("renders loading and error states instead of the empty state", () => {
    const { rerender } = render(<KeyUsagePanel loading now={NOW} />);
    expect(screen.getByText("Loading key usage...")).toBeInTheDocument();
    expect(screen.queryByText("No official key usage data yet.")).not.toBeInTheDocument();

    rerender(<KeyUsagePanel errorMessage="Metrics core offline" now={NOW} />);
    expect(screen.getByText("Metrics core offline")).toBeInTheDocument();
    expect(screen.queryByText("No official key usage data yet.")).not.toBeInTheDocument();
  });
});