import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import themeExtension from "../../extensions/theme.ts";

export interface FakeThemeInfo {
	name: string;
	path?: string;
}

export interface FakeNotification {
	message: string;
	type?: "info" | "warning" | "error";
}

export interface LoadOptions {
	themes: FakeThemeInfo[];
	/** Theme that is live when the extension loads. */
	active?: string;
	cwd?: string;
	mode?: "tui" | "rpc" | "print" | "json";
	hasUI?: boolean;
	/** Theme names whose setTheme() call fails, as a broken theme file would. */
	broken?: string[];
	/** Stand-in for ui.custom(): receives the factory the extension passes in. */
	custom?: PickerStub;
	/** Stand-in for ui.select() used by the non-TUI fallback. */
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}

/** What the extension's ui.custom() call looks like from the test side. */
export type PickerStub = (
	factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown,
) => Promise<unknown>;

export interface LoadedThemeExtension {
	/** Invoke `/theme <args>`. */
	run(args: string): Promise<void>;
	/** Invoke the command's argument autocomplete. */
	complete(prefix: string): Promise<AutocompleteItem[] | null>;
	/** Fire the registered keyboard shortcut, if any. */
	pressShortcut(): Promise<void>;
	readonly commandDescription?: string;
	readonly shortcut?: string;
	/** Every successful theme application, in order. */
	readonly applied: string[];
	/** Every setTheme() call, including the ones that failed. */
	readonly attempted: string[];
	readonly notifications: FakeNotification[];
	readonly active: string | undefined;
}

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

/**
 * Load extensions/theme.ts against a fake ExtensionAPI and a fake theme registry,
 * then expose the command, the shortcut, and everything the extension did.
 */
export function loadThemeExtension(opts: LoadOptions): LoadedThemeExtension {
	const broken = new Set(opts.broken ?? []);
	const applied: string[] = [];
	const attempted: string[] = [];
	const notifications: FakeNotification[] = [];
	let active = opts.active;

	let command: { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	let shortcut: { key: string; handler: (ctx: ExtensionContext) => Promise<void> | void } | undefined;
	const sessionStart: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];

	const ctx = {
		mode: opts.mode ?? "tui",
		hasUI: opts.hasUI ?? true,
		cwd: opts.cwd ?? "/tmp/theme-run",
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notifications.push({ message, type });
			},
			getAllThemes: () => opts.themes.map((info) => ({ name: info.name, path: info.path })),
			getTheme: (name: string) => (opts.themes.some((info) => info.name === name) ? { name } : undefined),
			setTheme(name: string) {
				attempted.push(name);
				if (broken.has(name)) return { success: false, error: "invalid color token" };
				active = name;
				applied.push(name);
				return { success: true };
			},
			get theme() {
				return { ...fakeTheme, name: active };
			},
			select: opts.select ?? (async () => undefined),
			confirm: async () => false,
			input: async () => undefined,
			custom: opts.custom ?? (async () => undefined),
		},
	} as unknown as ExtensionCommandContext;

	const pi = {
		registerCommand(name: string, options: typeof command) {
			if (name === "theme") command = options;
		},
		registerShortcut(key: string, options: { handler: (ctx: ExtensionContext) => Promise<void> | void }) {
			shortcut = { key, handler: options.handler };
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			if (event === "session_start") sessionStart.push(handler);
		},
	} as unknown as ExtensionAPI;

	themeExtension(pi);
	for (const handler of sessionStart) handler({ reason: "startup" }, ctx);

	return {
		run: async (args: string) => {
			if (!command) throw new Error("the extension registered no /theme command");
			await command.handler(args, ctx);
		},
		complete: async (prefix: string) => {
			if (!command?.getArgumentCompletions) return null;
			return (await command.getArgumentCompletions(prefix)) as AutocompleteItem[] | null;
		},
		pressShortcut: async () => {
			if (!shortcut) throw new Error("the extension registered no shortcut");
			await shortcut.handler(ctx);
		},
		get commandDescription() {
			return command?.description;
		},
		get shortcut() {
			return shortcut?.key;
		},
		applied,
		attempted,
		notifications,
		get active() {
			return active;
		},
	};
}

/** Last notification message, or "" when the extension stayed quiet. */
export function lastNotice(loaded: LoadedThemeExtension): string {
	return loaded.notifications.at(-1)?.message ?? "";
}
