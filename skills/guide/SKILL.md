---
name: guide
description: Show a quick-reference guide for all Token Pilot tools — when to use each one
command: guide
user_invocable: true
---

Display the following Token Pilot tool reference to the user. Show it exactly as formatted below.

---

## Token Pilot — Tool Reference

### Reading code
| Goal | Tool |
|------|------|
| Explore a file's structure | `smart_read(path)` |
| Read one function or class | `read_symbol(path, symbol="ClassName.method")` |
| Read a specific line range | `read_range(path, start, end)` |
| Get edit-ready exact text | `read_for_edit(path, symbol="name")` |
| Read many files at once | `smart_read_many([paths])` |

### Exploring a codebase
| Goal | Tool |
|------|------|
| First look at a new project | `project_overview()` |
| All symbols in a file | `outline(path)` |
| Deep dive on one area | `explore_area(path)` |
| Related files (imports, tests) | `related_files(path)` |
| Module deps + public API | `module_info(module_path)` |

### Finding things
| Goal | Tool |
|------|------|
| Where a symbol is used | `find_usages(symbol)` |
| Symbols with no references | `find_unused(path)` |

### After editing
| Goal | Tool |
|------|------|
| Verify your edit is correct | `read_diff(path)` |

### Git & tests
| Goal | Tool |
|------|------|
| Understand recent commits | `smart_log()` |
| Review a diff structurally | `smart_diff(base, head)` |
| Parse test output | `test_summary(command)` |

### Code quality
| Goal | Tool |
|------|------|
| Find TODOs, deprecated, patterns | `code_audit(path)` |

### Session
| Goal | Tool |
|------|------|
| Token savings this session | `session_analytics()` |

---

**Workflow:** `project_overview` → `explore_area` → `smart_read` → `read_symbol` → `read_for_edit` → edit → `read_diff`

**Tip:** `smart_read` on a file you've already read returns a compact reminder (dedup) — no wasted tokens.
