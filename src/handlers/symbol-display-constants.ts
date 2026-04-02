/** Shared display constants for symbol rendering (read_symbol, read_symbols). */

/** Symbols larger than this get auto-truncated to outline mode. */
export const MAX_SYMBOL_LINES = 300;

/** Symbols larger than this are never shown in full, even with show="full". */
export const MAX_FULL_LINES = 500;

/** Lines shown from the start in head/outline mode. */
export const SYMBOL_HEAD_LINES = 50;

/** Lines shown from the end in tail/outline mode. */
export const SYMBOL_TAIL_LINES = 30;
