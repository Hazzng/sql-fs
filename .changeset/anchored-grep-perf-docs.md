---
"virtualfs-api": patch
---

docs: warn agents that anchored grep patterns (`^`, `$`) are 10–24× slower than unanchored equivalents

Anchored patterns combined with alternation (e.g. `^foo\|^bar`) force GNU grep out of its Boyer-Moore fast path into line-by-line NFA/DFA evaluation. The `exec()` docstring, `ref/bash.md`, and `SKILL.md` now explain the trap with a benchmark table and show the canonical workaround: broad unanchored grep + Python/awk post-filter. Fixes #72.
