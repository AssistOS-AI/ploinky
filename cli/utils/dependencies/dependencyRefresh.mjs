import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

const operations = new AsyncLocalStorage();
const refreshCommands = new Set(['update', 'start', 'enable', 'reinstall']);

// One command can reach the same agent through several manifest edges.
// Only successful preparations are remembered, and never across commands.
export function withDependencyRefresh(command, run) {
    if (!refreshCommands.has(command) || operations.getStore()) return run();
    return operations.run(new Map(), run);
}

export function dependencyRefreshOperation() {
    return operations.getStore();
}

export function hasAgentPackageJson(agentPath) {
    const codePath = path.join(agentPath, 'code');
    return fs.existsSync(path.join(fs.existsSync(codePath) ? codePath : agentPath, 'package.json'));
}
