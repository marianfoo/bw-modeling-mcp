#!/usr/bin/env node
// stdio entry point (the `bw-modeling-mcp` bin). Local development and desktop MCP
// clients. For BTP Cloud Foundry with principal propagation, see http.ts.
import { startStdio } from './index.js';

startStdio().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
