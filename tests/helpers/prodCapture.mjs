// A test workspace that drives the Marketplace or WebTTY handlers needs a
// captured production state: without one the Router and the agents read PROD as
// true. This writes the capture a `start` of a non-production workspace would,
// into the controller-only data directory of the given workspace root.
import fs from 'node:fs';
import path from 'node:path';

export function writeProdCapture(workspaceRoot, { prod = false, routes = {} } = {}) {
    const file = path.join(workspaceRoot, '.ploinky', 'data', 'mcp-prod-gates.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schema: 1, prod, routes })}\n`);
    return file;
}
