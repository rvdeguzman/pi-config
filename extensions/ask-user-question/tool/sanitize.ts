import { stripTerminalSequences } from "@earendil-works/pi-tui";

const NON_SPACING_CONTROLS = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;
const LINE_SPACING = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const BLOCK_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Sanitize model-provided text that must remain one logical display row. */
export function sanitizeLine(value: string): string {
	return stripTerminalSequences(value)
		.replace(LINE_SPACING, " ")
		.replace(NON_SPACING_CONTROLS, "")
		.replace(/ +/g, " ")
		.trim();
}

/** Sanitize model/editor-provided text while preserving Markdown line structure. */
export function sanitizeBlock(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, " ")
		.replace(BLOCK_CONTROLS, "");
}
