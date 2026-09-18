---
"sql-fs-api": patch
---

Build a `replaceAll` edit without allocating per occurrence.

`split(oldString).join(newString)` materializes an array with one element per match before building the result — for a one-character `oldString` repeated through a file near the 64 MiB write limit that is tens of millions of slots, enough to exhaust the heap even though both the file and the edited result sit under the configured cap. The replacement is now assembled iteratively in flushed chunks: measured peak RSS for that worst case drops from 1184 MB to 357 MB (the `String.replaceAll` builtin, which also allocates per match, peaks at 2474 MB), with no regression on ordinary single-match edits.
