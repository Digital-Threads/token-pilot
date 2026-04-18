# Golden fixture repo

Minimal multi-language project used by Phase 4 tp-* agent tests. Content is
real — not lorem-ipsum — so that fixture-agent compatibility assertions
(Phase 4 subtask 4.11) can verify each agent's target artefacts exist.

| File | Used by |
|------|---------|
| `src/user.ts` | `tp-impact-analyzer` (find_usages target), `tp-refactor-planner` (edit surface) |
| `src/db.ts` | `tp-impact-analyzer` (direct caller of user.ts) |
| `src/api.ts` | `tp-impact-analyzer` (transitive), `tp-onboard` (entry point) |
| `src/helpers.py` | `tp-onboard` (multi-language demonstration) |
| `package.json` | `tp-onboard` (project_overview anchor) |
| `pr-diff.patch` | `tp-pr-reviewer` (smart_diff input) |
| `test-summary.txt` | `tp-test-triage` (test_summary input) |
| `tp-run` | exercises all of the above generically |

**Do not grow this fixture.** It is sized for behavioural smoke tests.
Larger coverage belongs in real benchmarks (Phase 7 / TP-m43), not here.
