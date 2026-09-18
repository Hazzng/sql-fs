---
"sql-fs-api": patch
---

Refuse an edit whose `oldString` or `newString` carries an unpaired surrogate, and check the encoded result against the write limit.

A file decoded from UTF-8 never holds a lone surrogate, but a caller can send one, and it matches half of a supplementary character. Re-encoding the result then turned the orphaned half into U+FFFD — rewriting bytes the edit never matched — and broke the size projection, whose arithmetic assumes a match encodes to the bytes it replaces: replacing the high surrogate of every `😀` in a 400-byte file under a 420-byte limit wrote 500 bytes and reported success. Such an edit is now rejected as `EDIT_LONE_SURROGATE` (400 on HTTP), and the write limit is enforced on the encoded result rather than on the projection alone.
