import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MissionRange } from "./MissionRange";

afterEach(cleanup);

test("presets set the end from the start and typed values are passed up", () => {
  const onChange = vi.fn();
  render(<MissionRange start="2026-12-01T06:30" end="2026-12-08T06:30" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "30 days" }));
  expect(onChange).toHaveBeenLastCalledWith("2026-12-01T06:30", "2026-12-31T06:30");
  fireEvent.change(screen.getByLabelText("Mission start (UTC)"), { target: { value: "2027-01-01T00:00" } });
  expect(onChange).toHaveBeenLastCalledWith("2027-01-01T00:00", "2026-12-08T06:30");
});

test("explains a backwards, over-long or missing range", () => {
  const { rerender } = render(<MissionRange start="2026-12-01T00:00" end="2026-11-30T00:00" onChange={() => {}} />);
  expect(screen.getByText("The end must be after the start.")).toBeInTheDocument();
  rerender(<MissionRange start="2026-12-01T00:00" end="2028-01-01T00:00" onChange={() => {}} />);
  expect(screen.getByText("The range can be at most 366 days.")).toBeInTheDocument();
  rerender(<MissionRange start="" end="2028-01-01T00:00" onChange={() => {}} />);
  expect(screen.getByText("Enter a start and an end.")).toBeInTheDocument();
});
