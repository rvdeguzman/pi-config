# Euler provenance

Euler is a small Pi-native working mode. Its behavior contract adapts a few
ideas from pstack (going deep before going fast, owning reversible choices,
writing less but better-verified code). It is written from scratch: it does not
install, vendor, wrap, or copy pstack's playbooks, agents, sticky-mode
metadata, setup commands, model routing, or Cursor-specific runtime.

## Pinned baseline

- Repository: <https://github.com/cursor/plugins>
- Commit: `e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`
- Plugin: `pstack/` version 0.15.9, author Lauren Tan
- License: MIT (`pstack/LICENSE` at that commit)

Re-read pstack at a newer commit only when deliberately revisiting Euler, and
update this file when you do.

## MIT notice (pstack)

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
