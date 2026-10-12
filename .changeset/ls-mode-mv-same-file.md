---
"sql-fs-api": patch
---

`ls -l` now shows each entry's real permissions, so `chmod 755 f; ls -l f` prints `-rwxr-xr-x` instead of a hardcoded `-rw-r--r--`. `mv a ./a` now fails with GNU's `mv: 'a' and './a' are the same file` and exit status 1 instead of succeeding silently. Both are fixed in the local just-bash patch until upstream fixes them.
