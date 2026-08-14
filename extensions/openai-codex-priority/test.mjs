import assert from "node:assert/strict";
import { applyPriority } from "./payload.ts";

assert.deepEqual(applyPriority({ model: "x" }, true), { model: "x", service_tier: "priority" });
assert.deepEqual(applyPriority({ model: "x", service_tier: "priority" }, false), { model: "x" });
assert.equal(applyPriority(null, false), null);
console.log("priority payload checks passed");
