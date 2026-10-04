/**
 * 1.0.2 audit — the Bash gate, as a decision table.
 *
 * Policy: block only clear, unbounded dumps of code; allow anything bounded
 * or piped into a bounding command; judge each segment of a compound
 * command on its own arguments; honour TOKEN_PILOT_BYPASS=1 (env and
 * command prefix); fail open on anything ambiguous.
 */
import { describe, expect, it } from "vitest";
import { decidePreBash } from "../../src/hooks/pre-bash.ts";

const decide = (command: string, opts: { bypass?: boolean; projectRoot?: string } = {}) =>
  decidePreBash({ tool_name: "Bash", tool_input: { command } }, "deny", opts).kind;

type Row = [command: string, expected: "allow" | "deny" | "advise"];

function table(title: string, rows: Row[], opts?: { projectRoot?: string }) {
  describe(title, () => {
    for (const [command, expected] of rows) {
      it(`${expected}: ${command}`, () => {
        expect(decide(command, opts)).toBe(expected);
      });
    }
  });
}

// Item 3 — recursive search in all its spellings; bounded forms pass.
table("recursive search", [
  ["grep -rn foo src", "deny"],
  ["grep -nr foo src", "deny"],
  ["grep -rni foo .", "deny"],
  ["grep --recursive foo src", "deny"],
  ["grep -R foo", "deny"],
  ["egrep -r 'a|b' src", "deny"],
  ["rg foo", "deny"],
  ["rg -n foo src/", "deny"],
  ["git grep foo", "deny"],
  ["git grep -n foo -- src", "deny"],
  ["grep -r foo src | head", "allow"],
  ["grep -rn foo src | head -n 20", "allow"],
  ["grep -r -m5 foo src", "allow"],
  ["grep -rm 5 foo src", "allow"],
  ["grep -rl foo src", "allow"],
  ["grep -rc foo src", "allow"],
  ["grep -r --files-with-matches foo src", "allow"],
  ["grep -r foo src | wc -l", "allow"],
  ["rg -l foo", "allow"],
  ["rg foo -m 3", "allow"],
  ["rg foo | head -20", "allow"],
  ["rg foo src/a.ts", "allow"],
  ["git grep -l foo", "allow"],
  ["git grep foo | head", "allow"],
  ["grep foo src/a.ts", "allow"],
  ["grep -rn foo src > hits.txt", "allow"],
  ["rg -r bar foo src/a.ts", "allow"],
]);

// Item 4 — compound commands: each segment on its own arguments.
table("compound commands", [
  ["cat package.json && node x.js", "allow"],
  ["cat README.md; node scripts/build.js", "allow"],
  ["git status && git diff -- src", "allow"],
  ["git log --oneline -1; git status", "allow"],
  ["npm run build && cat dist/index.js", "deny"],
  ["git status && git diff", "deny"],
  ["echo done || cat src/a.ts", "deny"],
]);

// Item 5 — dumps that used to pass.
table("dumps that used to pass", [
  ['cat "src/a.ts"', "deny"],
  ["cat 'src/a.ts'", "deny"],
  ["cat src/a.ts 2>/dev/null", "deny"],
  ["cat src/a.ts || true", "deny"],
  ["( cat src/a.ts )", "deny"],
  ["LC_ALL=C cat src/a.ts", "deny"],
  ['bash -lc "cat src/a.ts"', "deny"],
  ["for f in src/*.ts; do cat \"$f\"; done", "deny"],
  ["tail -n +1 src/a.ts", "deny"],
  ["head -n -1 src/a.ts", "deny"],
  ["head --lines=5000 src/a.ts", "deny"],
  ["head -c 200000 src/a.ts", "deny"],
  ["less src/a.ts", "deny"],
  ["more src/a.ts", "deny"],
  ["nl src/a.ts", "deny"],
  ["tac src/a.ts", "deny"],
  ["awk '{print}' src/a.ts", "deny"],
  ["awk 1 src/a.ts", "deny"],
  ["git --no-pager log", "deny"],
  ["git -C . log --oneline", "deny"],
  ["git --no-pager diff", "deny"],
  ["git diff HEAD", "deny"],
  ["git diff --cached", "deny"],
  ["git diff HEAD~50", "deny"],
  ["git show", "deny"],
  ["git show HEAD~3", "deny"],
  ["git show HEAD:src/a.ts", "deny"],
  ["find .", "deny"],
  ["find . -type f", "deny"],
  ["cat src/a.ts | cat", "deny"],
  ["cat src/a.ts | sort", "deny"],
  // Scripts are not dumps.
  ["python -c 'print(open(\"src/a.py\").read())'", "allow"],
  ["node -e 'require(\"./src/a.js\")'", "allow"],
]);

// Item 6 — cheap commands that used to be blocked.
table(
  "cheap commands",
  [
    ["sed -n '1,20p' src/a.ts", "allow"],
    ["sed -n '120,180p' src/a.ts", "allow"],
    ["sed -n '10p' src/a.ts", "allow"],
    ["sed -n '1,500p' src/a.ts", "deny"],
    ["sed -n '1,$p' src/a.ts", "deny"],
    ["sed 's/a/b/' src/a.ts", "deny"],
    ["sed -i 's/a/b/' src/a.ts", "allow"],
    ["sed 20q src/a.ts", "allow"],
    ["find /repo/src -name '*.ts'", "allow"],
    ["find /repo/src", "allow"],
    ["find /", "deny"],
    // Outside the project: a filter or a depth limit keeps the listing short.
    ["find /usr/include -name stdio.h", "allow"],
    ["find /usr/include -maxdepth 2 -name stdio.h", "allow"],
    ["find /tmp/x -name '*.mjs'", "allow"],
    ["find /home/u/.claude/plugins -name hooks.json", "allow"],
    ["find ~/.claude/plugins -name hooks.json", "allow"],
    ["find ~/.claude -maxdepth 2", "allow"],
    ["find /usr/include", "deny"],
    ["find / -type f", "deny"],
    ["find ~", "deny"],
    ["find ~/.claude/plugins", "deny"],
    ["find $HOME/projects", "deny"],
    ["find . -name '*.ts'", "allow"],
    ["find . -maxdepth 2", "allow"],
    ["find . -type f | wc -l", "allow"],
    ["git diff | head", "allow"],
    ["git diff | head -n 100", "allow"],
    ["git diff --stat HEAD~3", "allow"],
    ["git diff --cached --stat", "allow"],
    ["git diff --name-only main", "allow"],
    ["git diff main -- src/a.ts", "allow"],
    ["git show --stat HEAD", "allow"],
    ["git show -s --format=%H", "allow"],
    ["git show HEAD:package.json", "allow"],
    ["git show HEAD -- src/a.ts", "allow"],
    ["git log --max-count 5", "allow"],
    ["git log --max-count=5", "allow"],
    ["git log -n5", "allow"],
    ["git log -n 5 --stat", "allow"],
    ["git log main..HEAD --oneline", "allow"],
    ['git commit -m "find / -name x"', "allow"],
    ['git commit -m "cat src/a.ts"', "allow"],
    ['git commit -m "fix: grep -r and git log"', "allow"],
    ["head -n 50 src/a.ts", "allow"],
    ["tail -n 40 src/a.ts", "allow"],
    ["cat README.md", "allow"],
    ["cat docs/plan.md", "allow"],
    ["cat > src/a.ts <<'EOF'\nimport x from 'y';\ncat src/b.ts\nEOF", "allow"],
    ["cat src/a.ts > /tmp/copy.ts", "allow"],
    ["cat src/a.ts | grep import", "allow"],
    ["cat src/a.ts | head -n 30", "allow"],
    ["wc -l src/a.ts", "allow"],
  ],
  { projectRoot: "/repo" },
);

// Item 7 — the bypass the deny texts advertise.
describe("TOKEN_PILOT_BYPASS=1", () => {
  it("as a command prefix lets a dump through", () => {
    expect(decide("TOKEN_PILOT_BYPASS=1 cat src/a.ts")).toBe("allow");
    expect(decide("TOKEN_PILOT_BYPASS=1 grep -rn foo src")).toBe("allow");
  });

  it("from the environment lets a dump through", () => {
    expect(decide("cat src/a.ts", { bypass: true })).toBe("allow");
  });

  it("only when it is 1", () => {
    expect(decide("TOKEN_PILOT_BYPASS=0 cat src/a.ts")).toBe("deny");
  });
});

// Item 16 — the test-runner hint fires on running tests, not on mentions.
table("test-runner hint", [
  ["npm test", "advise"],
  ["npx vitest run tests/a.test.ts", "advise"],
  ["cd web && npm test", "advise"],
  ["npm install -D vitest", "allow"],
  ['git commit -m "fix jest config"', "allow"],
  ["cat > notes.txt <<EOF\nrun npm test later\nEOF", "allow"],
  ["echo pytest", "allow"],
]);

// Item 14 — one code-extension list for every gate.
table("code extensions", [
  ["cat src/App.vue", "deny"],
  ["cat src/App.svelte", "deny"],
  ["cat db/schema.sql", "deny"],
  ["cat src/a.cc", "deny"],
  ["cat build.gradle.kts", "deny"],
  ["cat src/a.mts", "deny"],
  ["cat src/a.cjs", "deny"],
  ["cat notes.md", "allow"],
]);

// Review 1.0.2 — rg with no path reads its stdin when that is a pipe;
// grep -r and git grep walk the tree whatever stdin is.
table("search reading a pipe", [
  ["ps aux | rg node", "allow"],
  ["env | rg PATH", "allow"],
  ["journalctl -u foo | rg -i error", "allow"],
  ["git log --oneline -n 50 | rg fix", "allow"],
  ["docker logs foo | rg error", "allow"],
  ["rg --files | rg pre-bash", "allow"],
  ["rg ERROR < app.log", "allow"],
  ["echo x | rg foo src", "deny"],
  ["ls | grep -r x", "deny"],
  ["git log -n 5 | git grep fix", "deny"],
]);

// Review 1.0.2 — an unquoted `$( )` or backtick in argument position is a
// word of the outer command, not the end of it; the inner command is judged
// on its own, with its output captured.
table(
  "command substitution",
  [
    ["git diff $(git merge-base HEAD main) -- src/x.ts", "allow"],
    ["git log $(git describe --tags --abbrev=0)..HEAD --oneline", "allow"],
    ["git show `git rev-parse HEAD` --stat", "allow"],
    ["git diff `git merge-base HEAD main` -- src/a.ts", "allow"],
    ["find $(pwd)/src -name '*.ts'", "allow"],
    ["git log -n $(echo 5)", "allow"],
    ["diff <(git show HEAD:src/a.ts) <(cat src/a.ts)", "allow"],
    ["x=$(npx vitest run)", "advise"],
    ["cat `echo` src/a.ts", "deny"],
    ["cat $(echo) src/a.ts | cat", "deny"],
    ["echo $(( 1 << 2 ))\ncat src/a.ts", "deny"],
  ],
  { projectRoot: "/repo" },
);

// Review 1.0.2 — a pipe after `)`, `}`, `done` or `fi` takes the output of
// every command in that group.
table("group piped into a bound", [
  ["{ git log; } | head", "allow"],
  ["{ cat a.ts; } | head -50", "allow"],
  ["(cat a.ts; echo) | head -50", "allow"],
  ["(cd sub && git log --oneline) | head -20", "allow"],
  ["for f in *.ts; do cat $f; done | head -100", "allow"],
  ['while read f; do cat "$f"; done < files.txt | head -50', "allow"],
  ["if true; then cat src/a.ts; fi | head", "allow"],
  ["(cat src/a.ts | sort; echo) | head", "allow"],
  ["{ cat src/a.ts; } | cat", "deny"],
  ["{ cat src/a.ts; }; echo x | head", "deny"],
  ["for f in *.ts; do cat $f; done", "deny"],
]);

// Review 1.0.2 — a redirection after `)`, `}`, `done` or `fi` sends the
// output of every command in that group to the file.
table("group redirected to a file", [
  ["{ cat a.ts; } > out.txt", "allow"],
  ["(cat a.ts) > out.txt", "allow"],
  ["for f in *.ts; do cat $f; done > out.txt", "allow"],
  ["if true; then cat a.ts; fi >> log.txt", "allow"],
  ["(cat a.ts) 2>/dev/null | head", "allow"],
  ["{ cat a.ts; } 2>/dev/null", "deny"],
  ["(cat a.ts) 2>&1", "deny"],
  ["(cat a.ts); echo x > out.txt", "deny"],
]);

// Review 1.0.2 — a head over the slice limit does not bound a whole-file
// viewer; `$'…'` quoting has backslash escapes.
table("viewer bounds and ANSI-C quotes", [
  ["cat src/a.ts | head -n 400", "deny"],
  ["cat src/a.ts | head -c 100000", "deny"],
  ["cat src/a.ts | head -n 300", "allow"],
  ["cat README.md | head -n 400", "allow"],
  ["git log | head -n 400", "allow"],
  ["echo $'it\\'s' && cat src/a.ts", "deny"],
  ["echo $'a\\nb' && ls", "allow"],
]);
