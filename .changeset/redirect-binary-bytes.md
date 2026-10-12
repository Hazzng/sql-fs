---
"sql-fs-api": patch
---

Fix scripts corrupting non-ASCII files written through a redirect. just-bash passes redirect output as a byte string with encoding `binary`, and SqlFs ignored the encoding and UTF-8 encoded it again, so every byte above `0x7f` became two: `cat a.txt > b.txt` turned `é` (`c3 a9`) into `c3 83 c2 a9`, and binary files copied with `cat` came out larger and broken. Writes now honour the encoding they are given.
