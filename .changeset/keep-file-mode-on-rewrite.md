---
"sql-fs-api": patch
---

Keep a file's mode when it is rewritten. `chmod 755 f; echo x >> f` (or `> f`, or `sed -i`) used to reset `f` to 0644. Also skip work just-bash 3.6 adds to every redirect: an empty append to an existing file is now a no-op instead of a full read and rewrite, and an empty file no longer commits a blob.
