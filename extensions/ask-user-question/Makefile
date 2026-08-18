PI_ROOT := $(shell npm root -g)/@earendil-works/pi-coding-agent
JITI := $(PI_ROOT)/node_modules/jiti/lib/jiti-cli.mjs

.PHONY: check
check:
	@node "$(JITI)" scripts/check.ts
