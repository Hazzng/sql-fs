---
"sql-fs-api": patch
---

Reading a large file inside a script is about 14x faster: `cat` of a 5 MB file went from 246 ms to 17 ms. SqlFs now implements `readFileBytes`, so just-bash decodes a file in one call instead of building the string one byte at a time and spending most of the read in garbage collection. The exec file-size ceiling still applies.
