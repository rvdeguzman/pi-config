// Pi's extension loader supplies these packages at runtime. Tests use the same
// installed packages without npm installs or symlinks in the user's config.
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PI_TEST_ENTRY) throw new Error("Run extension tests via make -C extensions/tests test.");
// SDK clients persist auth/usage even with mocked HTTP. Never touch live user state.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-extension-tests-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
cpSync(new URL("../../agents/", import.meta.url), join(isolatedAgentDir, "agents"), { recursive: true });
process.on("exit", () => rmSync(isolatedAgentDir, { recursive: true, force: true }));
globalThis.fetch = async () => { throw new Error("Unexpected network request in offline extension tests"); };

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
