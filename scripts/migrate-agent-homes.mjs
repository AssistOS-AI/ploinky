#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createBoxSupervisor } from '../ploinky-box/supervisor.mjs';

// Run from the deployment workspace with the installed Ploinky checkout.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--plan') {
    console.error('Usage: node /path/to/ploinky/scripts/migrate-agent-homes.mjs --plan /path/to/plan.json');
    process.exitCode = 1;
} else {
    try {
        const plan = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
        const result = await createBoxSupervisor().runAgentHomeMigration(plan);
        for (const entry of result) console.log(`${entry.source} -> ${entry.target}: ${entry.action}; rewritten rows: ${entry.rewrittenRows || 0}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
