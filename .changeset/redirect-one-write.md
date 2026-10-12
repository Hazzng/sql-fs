---
"sql-fs-api": patch
---

Scripts with many `>` redirects are faster again. Since just-bash 3.6 every `>` truncates its target when it opens it and writes the output when the command ends, and SqlFs committed both as separate filesystem operations. The script buffer now keeps only the second when nothing else happened between them, so a redirect costs one commit operation instead of two. A 2,000-redirect loop spent 10.8 s in its end-of-script commit before and 6.4 s after.
