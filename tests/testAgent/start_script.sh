#!/usr/bin/env node

const { writeFileSync, mkdirSync, existsSync } = require('node:fs');
const path = require('node:path');

// Write to WORKSPACE_PATH, the workspace selected by the runtime contract.
// The fast-suite container fixture binds its TEST_RUN_DIR at this path.
const workspacePath = process.env.WORKSPACE_PATH;
if (!workspacePath) {
    console.error('start_script: WORKSPACE_PATH not set');
} else {
    try {
        if (!existsSync(workspacePath)) {
            mkdirSync(workspacePath, { recursive: true });
        }
        writeFileSync(path.join(workspacePath, 'start-result'), 'started without shell\n');
    } catch (err) {
        console.error('start_script: failed to write start-result:', err.message);
    }
}

// Keep the entrypoint alive so the container stays running until the agent command is launched.
setInterval(() => {}, 1000);
