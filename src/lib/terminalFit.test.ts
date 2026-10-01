import { describe, expect, it } from "bun:test";
import { fixedGridWidthDimensions } from "./terminalFit.ts";

describe("fixed mirrored terminal width fitting", () => {
  it("keeps the source row count when the split cell is at least as wide", () => {
    expect(fixedGridWidthDimensions(120, 40, 140)).toEqual({ cols: 140, rows: 40 });
  });

  it("fits columns to a half-width cell without shrinking the remote vertical geometry", () => {
    expect(fixedGridWidthDimensions(120, 40, 60)).toEqual({ cols: 60, rows: 80 });
  });

  it("reserves enough local rows for source lines that can wrap several times", () => {
    expect(fixedGridWidthDimensions(121, 30, 40)).toEqual({ cols: 40, rows: 120 });
  });

  it("bounds degenerate dimensions instead of creating a zero-sized xterm", () => {
    expect(fixedGridWidthDimensions(0, 0, 0)).toEqual({ cols: 2, rows: 1 });
  });
});
