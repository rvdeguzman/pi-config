// Pi's extension loader supplies these packages at runtime. Tests use the same
// installed packages without npm installs or symlinks in the user's config.
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

if (!process.env.PI_TEST_ENTRY) throw new Error("Run extension tests via make -C extensions/tests test.");
const piURL = pathToFileURL(realpathSync(process.env.PI_TEST_ENTRY)).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (error.code !== "ERR_MODULE_NOT_FOUND" ||
				!(specifier.startsWith("@earendil-works/") || specifier === "typebox")) throw error;
			return nextResolve(specifier, { ...context, parentURL: piURL });
		}
	},
});
