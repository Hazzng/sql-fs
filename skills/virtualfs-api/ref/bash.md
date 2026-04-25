# VirtualFS — Bash Capabilities Reference

VirtualFS uses **just-bash** — a virtual bash interpreter with an in-memory command set.
It is NOT a real Linux shell. The following is the authoritative list of what works.

---

## Supported commands

### Filesystem
`cat`, `echo`, `ls`, `find`, `mkdir`, `rm`, `mv`, `cp`, `touch`, `chmod`, `stat`,
`ln` (hard links only — `-s` symlinks are off by default), `readlink`, `realpath`,
`dirname`, `basename`

### Text processing
`grep`, `sed`, `awk`, `sort`, `uniq`, `wc`, `head`, `tail`, `cut`, `tr`, `diff`,
`patch`, `printf`, `tee`

### Data / encoding
`base64`, `md5sum`, `sha1sum`, `sha256sum`, `xxd`

### Archives
`tar`, `gzip`, `gunzip`, `zcat`

### Structured data
`jq`, `yq`, `xan` (CSV/TSV Swiss Army knife), `sqlite3`

### Shell features
- Pipes: `cmd1 | cmd2`
- Redirects: `>`, `>>`, `<`, `2>`, `2>&1`
- Environment variables: `export FOO=bar`, `$FOO`, `${FOO:-default}`
- Conditionals: `if [ ... ]; then ... fi`, `[[ ... ]]`, `test`
- Loops: `for f in *; do ...; done`, `while read line; do ...; done`
- Functions: `myfn() { ...; }`
- Arithmetic: `$(( a + b ))`, `let`
- Command substitution: `$(cmd)`, `` `cmd` ``
- Here-docs: `cat <<EOF ... EOF`
- Brace expansion: `{a,b,c}`, `{1..5}`
- Glob: `*.ts`, `**/*.ts`

### String / number utilities
`expr`, `bc` (basic calculator), `date` (formatting only — no system time mutation)

---

## Optional runtimes (must be enabled at sandbox creation)

### Python — `python: true`
```bash
python3 -c "print(1 + 1)"
python3 script.py
```
- CPython WASM, full standard library
- No `pip`, no network, no `os.system`, no `subprocess`
- Server-wide concurrency cap: **5 concurrent python3 calls** (queue FIFO beyond that)
- Each invocation costs ~80 MB RAM; processes exit cleanly (EXIT_RUNTIME)

### JavaScript — `javascript: true`
```bash
js-exec script.js
node script.js    # alias for js-exec
```
- QuickJS WASM — fast startup, TypeScript supported
- No `npm`, no network, no `require('fs')` (use sandbox FS via bash instead)
- Server-wide concurrency cap: **5 concurrent js-exec calls**

---

## NOT supported

| Command | Why |
|---------|-----|
| `curl`, `wget`, `nc`, `ssh` | No network access of any kind |
| `apt`, `pip`, `npm`, `brew` | No package managers |
| `vi`, `vim`, `nano`, `less`, `more` | No interactive/terminal-control commands |
| `&` (background jobs) | No process control |
| `kill`, `ps`, `top`, `jobs` | No process management |
| `/proc`, `/sys`, `/dev` | No special filesystems |
| `ln -s` (symlinks) | Off by default; requires `allowSymlinks` flag at dialect level |
| `gcc`, `make`, `rustc`, `go` | No compilers |
| `docker`, `kubectl` | No container runtimes |
| `sudo`, `su` | No privilege escalation |
| `cron`, `at` | No scheduling |
| `mount`, `umount` | No filesystem mounting |

---

## Shell state persistence

Within a single sandbox session (no idle eviction):
- `export VAR=value` — persists across exec-sync calls
- `cd /some/path` — persists (cwd is tracked per Bash instance)
- Shell functions defined in one call — available in the next

After session eviction (10 min idle) or on a cold replica:
- Shell state resets to a fresh Bash instance
- **Filesystem state is fully preserved** (Postgres is durable)
- The `HOME`, `PATH`, and default env vars are restored from the Bash constructor options

---

## Performance characteristics

| Operation | Approx time |
|-----------|-------------|
| `echo hello` | < 10 ms |
| `find /home/user -type f` (100 files, pathCache warm) | < 10 ms |
| `cat large_file.txt` (contentCache warm) | < 10 ms |
| `cat large_file.txt` (cold, 1 MB blob from Neon) | ~300 ms |
| `tar -xzf archive.tar.gz` (10 files via just-bash) | ~3 s |
| `python3 -c "..."` (first call, WASM init) | ~2–5 s |
| `python3 -c "..."` (subsequent calls) | ~500 ms–1 s |

---

## Writing robust scripts

```bash
# Always quote variables to handle spaces
script="cat '${filepath}'"

# Use set -e to fail fast (npm/pip/etc are NOT available — call shipped scripts instead)
script="set -e && ./scripts/build.sh && ./scripts/test.sh"

# Capture both stdout and stderr
script="cmd 2>&1"

# Check exit codes explicitly
script="
if grep -q pattern file.txt; then
  echo found
else
  echo not_found
fi
"

# Multi-line scripts work fine
script="
for f in /home/user/src/*.ts; do
  echo '=== '$f' ==='
  wc -l \"\$f\"
done
"
```
