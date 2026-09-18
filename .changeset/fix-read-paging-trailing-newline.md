---
"sql-fs-api": patch
---

Keep `file_read` paging identical to the `split`/`join` it replaced when a file ends in a newline.

A newline-terminated file has a synthetic empty last line that starts at the end of the text, so deciding "is there a separator to drop?" from the offset alone treated a page ending on the final non-empty line as if it ran to EOF and returned a trailing newline that `split`/`join` would have dropped. `/lines.txt` holding `a\nb\nc\nd\n` read with `offset: 1, limit: 4` returned `a\nb\nc\nd\n` instead of `a\nb\nc\nd`. The decision is now made against the line count.
