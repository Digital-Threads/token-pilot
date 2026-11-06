/** One-line terminal prompts for the interactive CLI commands. */

import { createInterface } from "node:readline";

async function promptLine(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise<string>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Yes/no on a TTY; false without one. */
export async function promptYesNo(
  question: string,
  defaultYes: boolean = true,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const ans = (await promptLine(question + suffix)).toLowerCase();
  if (ans === "") return defaultYes;
  return ans === "y" || ans === "yes";
}
