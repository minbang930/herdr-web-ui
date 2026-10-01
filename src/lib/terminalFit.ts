/**
 * A fixed/mirrored terminal owns its source geometry on the remote PC, so the browser cannot
 * resize that PTY. In split view we can still make the local xterm fit the cell horizontally.
 *
 * Keep enough local rows for the source screen even when a full-width source row wraps into
 * several local rows. The split cell clips/scrolls vertically, so this changes only the local
 * presentation and never tells the remote pane to shrink vertically.
 */
export function fixedGridWidthDimensions(sourceCols: number, sourceRows: number, fittedCols: number): { cols: number; rows: number } {
  const safeSourceCols = Math.max(1, Math.floor(sourceCols));
  const safeSourceRows = Math.max(1, Math.floor(sourceRows));
  const cols = Math.max(2, Math.floor(fittedCols));
  const wrappedRowsPerSourceRow = Math.max(1, Math.ceil(safeSourceCols / cols));
  return { cols, rows: safeSourceRows * wrappedRowsPerSourceRow };
}
