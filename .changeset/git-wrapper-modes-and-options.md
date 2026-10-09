---
"sql-fs-api": patch
---

Sandbox git now keeps executable files executable and honours `-c`, `-C` and `--no-pager`. A cloned or checked-out `100755` file used to land as 0644, so `./gradlew` failed with "Permission denied" and the next `git add -A` committed a `100755 -> 100644` change nobody made (blindmansion/just-git#10); every file git writes now gets the mode its index entry records. `git -c user.name=x -c user.email=y commit` used to print the help text and exit 0 without committing (blindmansion/just-git#11); identity keys now apply to that command, keys with no effect in a sandbox are ignored, and any other `-c` key or unknown global option exits 129.
