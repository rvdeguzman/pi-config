MODEL := qwen3.5:9b-pi
PI_FLAGS := --offline --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files

.PHONY: start stop status configure test

start:
	brew services start ollama

stop:
	brew services stop ollama

status:
	ollama list
	ollama ps

configure:
	ollama create $(MODEL) -f Modelfile

test:
	pi $(PI_FLAGS) --provider ollama --model $(MODEL) --thinking off --tools read -p 'Use the read tool to read ./Modelfile. Report only the num_ctx value.'
