---
"virtualfs-api": minor
---

feat(py-exec): add warm Python interpreter to eliminate 1.4s startup cost per invocation

Introduces `py-exec`, a new bash command available in `python=true` sandboxes that routes Python execution through a persistent `python3` process instead of spawning a fresh CPython/WASM worker on every call.

**Before:** `python3 -c 'print(1)'` → ~1.4 s per call (WASM cold boot)  
**After:** `py-exec -c 'print(1)'` → ~30–50 ms per call after first use

The warm process uses a base64-encoded stdin/stdout turn protocol so arbitrary Python code (including multi-line scripts and `sys.exit()`) works safely without shell-quoting hazards. Variables persist across calls in the same session (stateful REPL semantics).

The built-in `python3` command is still available for isolated, stateless execution.
