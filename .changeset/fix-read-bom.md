---
"sql-fs-api": patch
---

Keep a leading UTF-8 BOM in what `file_read` and `fs_export` return.

The default `TextDecoder` consumes a leading U+FEFF, so a file that began with one came back without it: reading a file and writing the content back stripped the marker, and because `stat.size` still counted those three bytes, every `nextByteOffset` sat three bytes off the file's own. `editFile` already decoded with `ignoreBOM` for exactly this reason; the read paths now match, so content round-trips byte for byte.
