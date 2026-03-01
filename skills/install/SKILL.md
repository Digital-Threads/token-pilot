---
name: install
description: Install or check ast-index binary (auto-downloads if missing)
command: install
user_invocable: true
---

Run the following command to install or verify the ast-index binary:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/index.js install-ast-index
```

Show the output to the user. If ast-index is already installed, confirm the version. If it needs to be downloaded, show progress.
