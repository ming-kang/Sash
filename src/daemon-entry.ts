#!/usr/bin/env node
import "./node-version-guard.js";
import { runDaemon } from "./daemon/entry.js";

async function main(): Promise<void> {
  try {
    await runDaemon();
  } catch (err) {
    console.error(`[sashd] fatal: ${(err as Error).message}`);
    process.exit(1);
  }
}

await main();
