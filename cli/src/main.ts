#!/usr/bin/env node
import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  fetch,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
