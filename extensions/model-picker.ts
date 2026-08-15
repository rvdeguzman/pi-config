import type { ExtensionAPI, ScopedModel } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

type ModelItem = ScopedModel;

function modelText(item: ModelItem) {
	const model = item.model;
	return `${model.provider}/${model.id} ${model.name}`;
}

export default function modelPicker(pi: ExtensionAPI) {
	pi.registerShortcut(Key.alt("p"), {
		description: "fuzzy-select a model",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;

			const items: ModelItem[] = ctx.scopedModels.length
				? [...ctx.scopedModels]
				: ctx.modelRegistry.getAvailable().map((model) => ({ model }));
			if (items.length === 0) {
				ctx.ui.notify("no available models", "warning");
				return;
			}

			const idWidth = Math.max(...items.map(({ model }) => model.id.length));
			const result = await ctx.ui.custom<ModelItem | null>((tui, theme, _keybindings, done) => {
				const input = new Input();
				input.focused = true;

				let filtered = items;
				let previousQuery = "";
				let selected = Math.max(
					0,
					items.findIndex(({ model }) => model.provider === ctx.model?.provider && model.id === ctx.model?.id),
				);

				const container = new Container();
				container.addChild(new DynamicBorder((line) => theme.fg("accent", line)));
				container.addChild(new Text(theme.fg("accent", theme.bold("select model")), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(input);
				container.addChild(new Spacer(1));

				const list = new Container();
				container.addChild(list);
				container.addChild(new DynamicBorder((line) => theme.fg("accent", line)));

				const update = () => {
					const query = input.getValue();
					filtered = query ? fuzzyFilter(items, query, modelText) : items;
					if (query !== previousQuery) selected = 0;
					if (!query) selected = Math.min(selected, Math.max(0, filtered.length - 1));
					previousQuery = query;
					list.clear();

					const maxVisible = 10;
					const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), filtered.length - maxVisible));
					for (let i = start; i < Math.min(start + maxVisible, filtered.length); i++) {
						const item = filtered[i];
						if (!item) continue;
						const current = item.model.provider === ctx.model?.provider && item.model.id === ctx.model?.id;
						const check = current ? theme.fg("success", " ✓") : "";
						const id = item.model.id.padEnd(idWidth);
						const line = `  ${i === selected ? theme.fg("accent", id) : id}  ${theme.fg("muted", `[${item.model.provider}]`)}${check}`;
						list.addChild(new Text(line, 0, 0));
					}
					if (start > 0 || start + maxVisible < filtered.length) {
						list.addChild(new Text(theme.fg("dim", `  (${selected + 1}/${filtered.length})`), 0, 0));
					}
					if (filtered.length === 0) list.addChild(new Text(theme.fg("warning", "no matching models"), 0, 0));
				};

				update();

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(null);
						if (matchesKey(data, Key.enter)) return done(filtered[selected] ?? null);
						if (matchesKey(data, Key.up)) {
							if (filtered.length) selected = selected === 0 ? filtered.length - 1 : selected - 1;
							update();
						} else if (matchesKey(data, Key.down)) {
							if (filtered.length) selected = (selected + 1) % filtered.length;
							update();
						} else {
							input.handleInput(data);
							update();
						}
						tui.requestRender();
					},
				};
			});

			if (!result) return;
			const ok = await pi.setModel(result.model);
			if (!ok) {
				ctx.ui.notify(`no api key for ${result.model.provider}/${result.model.id}`, "error");
				return;
			}
			if (result.thinkingLevel) pi.setThinkingLevel(result.thinkingLevel);
			ctx.ui.notify(`model: ${result.model.provider}/${result.model.id}`, "info");
		},
	});
}
