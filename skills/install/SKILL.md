---
name: install
description: Install or check ast-index binary (auto-downloads if missing)
command: install
user_invocable: true
# v0.43.0 — effort (Claude Code 2.1.16x). install drives one
# `npx token-pilot install-ast-index` Bash call; no reasoning needed,
# so `low` keeps it fast and cheap.
effort: low
# v0.36.0 — disallowed-tools (Claude Code 2.1.152+). The install
# skill drives one `npx token-pilot install-ast-index` Bash command;
# nothing else. Keep Bash, block all write/edit/delegation tools so
# a rogue interpretation can't extend the install into arbitrary
# workspace mutation.
disallowed-tools:
  - Edit
  - MultiEdit
  - Write
  - Task
---

Run the following command to install or verify the ast-index binary:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/index.js install-ast-index
```

Show the output to the user. If ast-index is already installed, confirm the version. If it needs to be downloaded, show progress.
