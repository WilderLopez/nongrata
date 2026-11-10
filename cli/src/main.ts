#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { run } from "./cli.ts";

/** One line from stdin, or `null` if it ends first (question() would never settle then). */
async function ask(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
  try {
    return await Promise.race([rl.question(question), closed]);
  } finally {
    rl.close();
  }
}

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  fetch,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  ask,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
