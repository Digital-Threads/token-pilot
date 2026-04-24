# Draft — GitHub Discussion / Issue to the caveman author

**Repo:** https://github.com/JuliusBrussee/caveman
**Target form:** GitHub Discussion (preferred — less formal than an issue), category "Show and tell" or "Ideas".
**Author to contact:** [@JuliusBrussee](https://github.com/JuliusBrussee)

---

## Why this outreach is worth their time

caveman is small but active. Any proposal has to pass a "why bother" filter:

1. **We don't compete.** caveman cuts output tokens via prompt style; token-pilot cuts input tokens via MCP structural reads. Zero overlap on mechanism or scope.
2. **Combined data is interesting to both sides.** A user running both can tell exactly which half of a session each tool owned — nobody has published those numbers yet.
3. **Low-effort ask.** We suggest a reciprocal README link and (optionally) shared benchmarks. No code integration required on their side.
4. **We bring a real-usage telemetry story.** Our `tool-audit` data across three active projects (2026-04-24) is proof that MCP-based tool routing moves agent behaviour — they can reference it in their own pitches for "this is how agents are measured today".

## Tone

- Direct, peer-to-peer. Not fan mail, not sales pitch.
- Lead with what we built and the gap we noticed, not with "please notice us".
- Offer, don't beg. "Happy to PR the link ourselves" is better than "could you add a link".

---

## Draft text

**Title suggestion:** *"Pair with token-pilot for the input side — complementary coverage, data attached"*

```
Hey Julius,

Enjoyed caveman — we're on the same problem from a different angle and
I wanted to share what we built in case there's room for a reciprocal
link.

## What we do

token-pilot (https://github.com/Digital-Threads/token-pilot) is an MCP
server + PreToolUse hook layer that cuts **input** tokens:

- structural reads instead of full-file dumps (`smart_read`,
  `read_symbol`) — 60-90% on code files ≥ 200 lines;
- PreToolUse hooks that intercept heavy Bash / Grep / Edit / Write
  calls and route them to token-lean MCP equivalents;
- disk-backed session state so a hook subprocess can enforce rules
  like "no Edit without a prior read_for_edit" across restarts.

## Why I'm writing

You own output compression (response prose); we own input compression
(what Claude reads in). Zero mechanism overlap. A user running both
should see ~85-90% total reduction — each cuts a different half.

From real tool-audit data across three active projects last week:

| Project                | Calls | Input savings (our side) |
|------------------------|------:|-------------------------:|
| playerok/pl-api        | 138   | 92%                      |
| docker-local-env       | 228   | 94%                      |
| telegram-microlearning | 191   | 80%                      |

These are *input* savings. Combined with caveman's ~75% on output,
users would see numbers nobody's published yet.

## Proposal (low effort on your side)

1. Reciprocal README link. Happy to PR ours first so you see the
   framing — we already ship a "pair with caveman for the output side"
   section in v0.30.1.
2. If you're curious, publish joint benchmarks — `caveman + token-pilot`
   vs baseline on the same fixtures. I'll run the numbers and share.
3. Long term, if this works out, we've thought about an `ai-coding-
   savings-pack` meta-plugin that bundles token-pilot + caveman +
   ast-index. Not asking for that now — just flagging the direction.

No pressure if it's not a fit. Either way, nice build — "why use many
token when few do trick" is the single best tagline in this entire
space.

— Mher (digital-threads)
```

## What to do *before* sending

- [ ] Publish v0.30.1 to npm + marketplace (so the link in the message resolves).
- [ ] Make sure `docs/ecosystem.md` is on master (mentions caveman by name, with link).
- [ ] Add a line in our README pointing at `docs/ecosystem.md`.
- [ ] Read caveman's open discussions / recent issues — if the author has signalled direction, reference it so the message feels contextual instead of generic.

## What to do *after* sending

- **If positive reply within a week:** move to Phase 2 (`token-pilot doctor` checks for caveman, nudges install).
- **If polite but uninterested:** keep our side live — ecosystem page on our repo is already useful to our users.
- **If ignored:** send a single gentle ping after 2 weeks if something concrete changes (e.g. new telemetry data worth sharing). Then drop it.

## Backup channel

If GitHub Discussion gets no traction, the repo has no listed email, but the commit log shows `JuliusBrussee@` commits — a short email would work. Do NOT cold-DM on Twitter — too salesy for a dev-to-dev first contact.
