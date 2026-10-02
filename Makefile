.DEFAULT_GOAL := setup

.PHONY: setup restore-settings packages test-setup

setup: packages

# Never replace local preferences or touch credentials.
restore-settings:
	@if [ -e settings.json ] || [ -L settings.json ]; then \
		printf '%s\n' 'Keeping existing settings.json'; \
	else \
		cp settings.example.json settings.json; \
		printf '%s\n' 'Restored settings.json from settings.example.json'; \
	fi

# Install into this checkout, even if the caller has a different agent directory.
packages: restore-settings
	PI_CODING_AGENT_DIR="$(CURDIR)" pi update --extensions --no-approve

test-setup:
	node --test scripts/setup.test.mjs
