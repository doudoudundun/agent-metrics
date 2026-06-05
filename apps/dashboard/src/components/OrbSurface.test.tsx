import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrbSurface } from "./OrbSurface";

afterEach(() => {
  cleanup();
});

describe("OrbSurface", () => {
  it("renders a clickable button for opening the desktop peek card", () => {
    render(<OrbSurface collapsed={false} stale={false} />);

    expect(
      screen.getByRole("button", { name: "Open desktop peek card" })
    ).toBeInTheDocument();
  });

  it("forwards pointer and click events", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    const onClick = vi.fn();

    render(
      <OrbSurface
        collapsed={true}
        stale={true}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
      />
    );

    const button = screen.getByRole("button", { name: "Open desktop peek card" });
    fireEvent.pointerEnter(button);
    fireEvent.pointerLeave(button);
    fireEvent.click(button);

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
