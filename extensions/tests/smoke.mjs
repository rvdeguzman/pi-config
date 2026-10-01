import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

// Keep credentials/usage isolated by register-pi.mjs, but load the real local
// entry points rather than the empty extensions directory in that sandbox.
const root = resolve("extensions");
const paths = readdirSync(root, { withFileTypes: true }).flatMap(entry => {
	const path = join(root, entry.name);
	if (entry.isFile() && /\.[jt]s$/.test(entry.name)) return [path];
	if (!entry.isDirectory()) return [];
	return [join(path, "index.ts"), join(path, "index.js")].filter(existsSync).slice(0, 1);
});
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	additionalExtensionPaths: paths,
});
await loader.reload();
const result = loader.getExtensions();
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, paths.length);
assert.ok(result.extensions.some(extension => extension.commands.has("quota")), "Local extensions must load");
for (const extension of result.extensions) {
	console.log(extension.path, [...extension.commands.keys()].map(name => "/" + name).join(" "));
}
