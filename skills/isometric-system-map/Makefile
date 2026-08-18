SPEC  ?= system.json
OUT   ?= system-map.html
ROOT  ?= .
SHOTS ?= /tmp/isometric-system-map-shots
HERE := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.DEFAULT_GOAL := help

help: ## show targets
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | expand -t22

render: ## render a spec: make render SPEC=... OUT=... ROOT=<repo being mapped>
	@node $(HERE)render.mjs --spec "$(SPEC)" --out "$(OUT)" --root "$(ROOT)"

validate: ## check schema, codes, dangling edges and every citation on disk
	@node $(HERE)render.mjs --spec "$(SPEC)" --root "$(ROOT)" --validate-only

shots: ## screenshot the map in every state: make shots OUT=map.html
	@node $(HERE)shots.mjs --html "$(OUT)" --out "$(SHOTS)"

check: render shots ## render, then screenshot every state for a visual pass

demo: ## render the bundled fixture to /tmp and print the path
	@node $(HERE)render.mjs --spec "$(HERE)example/system.json" \
		--root "$(HERE)example/tree" --out /tmp/isometric-system-map-demo.html
	@echo "open /tmp/isometric-system-map-demo.html"

open: demo ## render the fixture and open it
	@open /tmp/isometric-system-map-demo.html

demo-shots: demo ## screenshot the fixture in every state
	@node $(HERE)shots.mjs --html /tmp/isometric-system-map-demo.html --out "$(SHOTS)"

.PHONY: help render validate shots check demo open demo-shots
