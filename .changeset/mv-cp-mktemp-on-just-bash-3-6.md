---
"sql-fs-api": patch
---

Make `mv` and `cp` onto an existing file and `mktemp` work on just-bash 3.6. Its `mv`/`cp` refuse to replace a target unless the filesystem can prove the two paths are different files, so `jq ... > tmp && mv tmp file` failed with "cannot safely determine whether ... are the same file"; SqlFs `stat` now reports an inode identity. Its `mktemp` creates through an atomic `createExclusive`, which SqlFs now implements, so temp files are 0600 and temp directories 0700.
