import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const K = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	esc: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	space: " ",
} as const;

let failures = 0;
let checks = 0;
let cases = 0;

export function check(name: string, condition: boolean, extra?: unknown): void {
	checks++;
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures++;
	console.log(`  FAIL ${name}${extra === undefined ? "" : `: ${formatExtra(extra)}`}`);
}

/** JSON-shape equality, reporting both sides when they differ. */
export function checkEquals(name: string, actual: unknown, expected: unknown): void {
	const got = JSON.stringify(actual);
	const want = JSON.stringify(expected);
	check(name, got === want, got === want ? undefined : `expected ${want}, got ${got}`);
}

function formatExtra(extra: unknown): string {
	if (extra instanceof Error) return extra.stack ?? extra.message;
	if (typeof extra === "string") return extra;
	try {
		return JSON.stringify(extra);
	} catch {
		return String(extra);
	}
}

/** Wrap every test case in a hard watchdog so a broken component cannot hang the suite. */
export async function test(name: string, body: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
	cases++;
	console.log(`\n${name}`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(body),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`test case exceeded ${timeoutMs}ms watchdog`)), timeoutMs);
			}),
		]);
	} catch (error) {
		check(`${name} completed without throwing`, false, error);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function report(): never {
	const passed = checks - failures;
	console.log(`\n${passed}/${checks} checks passed across ${cases} cases; ${failures} failed.`);
	process.exit(failures === 0 ? 0 : 1);
}

export interface DialogComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

export function screen(component: DialogComponent, width = 90): string {
	return component.render(width).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

export function type(component: DialogComponent, ...keys: string[]): void {
	if (!component.handleInput) throw new Error("dialog component has no handleInput method");
	for (const key of keys) component.handleInput(key);
}

export interface DriveState {
	readonly aborted: boolean;
	readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
	readonly component?: DialogComponent;
	readonly outcome?: unknown;
}

export interface DriveOptions {
	cwd?: string;
	watchdogMs?: number;
}

export interface DrivenDialog {
	ctx: ExtensionContext;
	state: DriveState;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

/**
 * Construct a TUI ExtensionContext that exposes the live custom component to a driver.
 * The ui.custom promise has its own watchdog: returning from the driver without calling
 * done is allowed briefly (for timer-driven dialogs), but rejects within two seconds.
 */
export function driveDialog(
	drive: (component: DialogComponent, render: (width?: number) => string) => void | Promise<void>,
	opts: DriveOptions = {},
): DrivenDialog {
	let aborted = false;
	let liveComponent: DialogComponent | undefined;
	let outcome: unknown;
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	const watchdogMs = opts.watchdogMs ?? 2_000;

	const state: DriveState = {
		get aborted() {
			return aborted;
		},
		get notifications() {
			return notifications;
		},
		get component() {
			return liveComponent;
		},
		get outcome() {
			return outcome;
		},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: opts.cwd ?? "/tmp/ask-run",
		abort() {
			aborted = true;
		},
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notifications.push({ message, type });
			},
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => DialogComponent | Promise<DialogComponent>): Promise<T> {
				return new Promise<T>((resolve, reject) => {
					let settled = false;
					let component: DialogComponent | undefined;
					const timer = setTimeout(() => {
						if (settled) return;
						settled = true;
						component?.dispose?.();
						reject(new Error(`dialog never completed within ${watchdogMs}ms`));
					}, watchdogMs);

					const finish = (value: T) => {
						if (settled) return;
						settled = true;
						outcome = value;
						clearTimeout(timer);
						component?.dispose?.();
						resolve(value);
					};

					// Editor.render() reads tui.terminal.rows to cap its viewport, even in a
					// headless component. Keep the fake terminal dimensions deterministic.
					const fakeTui = {
						terminal: { rows: 40, columns: 90 },
						requestRender() {},
						invalidate() {},
					};
					void Promise.resolve(factory(fakeTui, theme, {}, finish))
						.then(async (created) => {
							component = created;
							liveComponent = created;
							if (settled) {
								created.dispose?.();
								return;
							}
							await drive(created, (width = 90) => screen(created, width));
						})
						.catch((error) => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							component?.dispose?.();
							reject(error);
						});
				});
			},
		},
	} as unknown as ExtensionContext;

	return { ctx, state };
}
