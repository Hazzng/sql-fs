---
"virtualfs-api": patch
---

just-bash's built-in nodeStubCommand (registered alongside js-exec when javascript=true) ignores all arguments and unconditionally prints the full 60-line js-exec --help page to stderr before exiting 1. Added src/api/commands/node-command.ts — a custom Command that replaces the built-in stub via BashOptions.customCommands (which takes precedence over built-ins with the same name). Custom commands are only injected when javascript: true; non-JS sandboxes are unaffected.
