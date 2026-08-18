import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * Escape sequences pi-tui's `stripTerminalSequences` leaves behind. Its `extractAnsiCode`
 * only recognizes CSI forms ending in `m/G/K/H/J` plus terminated OSC/APC, so a cursor move
 * like `ESC [ 2 A` survives; dropping only the ESC byte would leak a literal `[2A` into the
 * dialog. Covers full CSI, unterminated OSC/DCS/APC/PM strings, and two-byte ESC commands.
 */
const RESIDUAL_ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

const NON_SPACING_CONTROLS = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;
const LINE_SPACING = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const BLOCK_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Sanitize model-provided text that must remain one logical display row. */
export function sanitizeLine(value: string): string {
	return stripTerminalSequences(value)
		.replace(RESIDUAL_ESCAPES, "")
		.replace(LINE_SPACING, " ")
		.replace(NON_SPACING_CONTROLS, "")
		.replace(/ +/g, " ")
		.trim();
}

/** Sanitize model/editor-provided text while preserving Markdown line structure. */
export function sanitizeBlock(value: string): string {
	return stripTerminalSequences(value)
		.replace(RESIDUAL_ESCAPES, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, " ")
		.replace(BLOCK_CONTROLS, "");
}
