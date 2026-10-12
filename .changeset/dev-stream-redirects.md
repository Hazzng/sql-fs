---
"sql-fs-api": patch
---

`cmd &> /dev/stderr`, `&> /dev/stdout` and `&>>` to either no longer fail the whole exec with a 404. just-bash 3.6 sent `&>` targets through the filesystem, which has no `/dev`; the local just-bash patch now routes them to the current stdout/stderr like `>` does, until vercel-labs/just-bash#562 is released.
