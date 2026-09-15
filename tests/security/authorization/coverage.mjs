import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentCatalog, agentInventory, inventoryBaseline } from './agent-inventory.mjs';
import { routerInventory } from './router-inventory.mjs';
import { artifactDestination } from './core.mjs';

export const inventoryRows = [...routerInventory.map(row => ({ repo: 'ploinky', ...row })), ...agentInventory];
const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
const pathname = value => String(value || '').split('?')[0];

export function matchesInventory(row, request) {
    const methods = row.method.split('|');
    if (!methods.includes('*') && !methods.includes(request.method)) return false;
    if (row.tool && (request.rpcMethod !== 'tools/call' || request.tool !== row.tool)) return false;
    if (row.rpcMethod && request.rpcMethod !== row.rpcMethod) return false;
    if (row.body?.action && row.body.action !== request.operation) return false;
    const pattern = pathname(row.path).split('/').map(part => {
        if (part === '*') return '.*';
        if (part.startsWith(':')) return '[^/]+';
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return new RegExp(`^${pattern}$`).test(pathname(request.path));
}

export function coverageRows(report = { requests: [], checks: [] }) {
    return inventoryRows.map(row => {
        const requests = report.requests.map((request, i) => ({ ...request, number: i + 1 })).filter(request => matchesInventory(row, request));
        const checks = report.checks.filter(check => requests.some(request => request.number >= check.requests[0] && request.number <= check.requests[1]));
        const family = row.path.includes('*') || row.method === '*' || /family/.test(row.transport || '');
        // A matching request is contact evidence only. It never establishes all
        // role/argument/alias checks for a dynamic endpoint family.
        return { ...row, tests: [...new Set(checks.map(check => check.id))], actorsContacted: [...new Set(requests.map(request => request.actor))], requestNumbers: requests.map(request => request.number), observedCheckStatuses: [...new Set(checks.map(check => check.status))],
            coverage: !requests.length ? 'NOT_EXERCISED' : family ? 'FAMILY_PARTIAL_CONTACT' : checks.length ? 'ASSERTIONS_RECORDED_REVIEW_RESULTS' : 'CONTACT_ONLY_NO_ASSERTION',
            completeAuthorizationCoverage: false };
    });
}

export async function writeCoverage(outputRoot, report = { requests: [], checks: [], gaps: [] }) {
    const source = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
    const output = await artifactDestination(source, outputRoot);
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    assert.equal(await fs.realpath(output), output, 'Coverage output parent changed during creation');
    const rows = coverageRows(report);
    const summary = { routerRows: routerInventory.length, agentRows: agentInventory.length, agents: agentCatalog.length, enabledAgents: agentCatalog.filter(agent => agent.enabled).length, declaredTools: agentInventory.filter(row => row.tool).length, contactedRows: rows.filter(row => row.requestNumbers.length).length, unexercisedRows: rows.filter(row => !row.requestNumbers.length).length, completeEndpointInventory: false, completeAuthorizationCoverage: false };
    await fs.writeFile(path.join(output, 'endpoint-coverage.json'), JSON.stringify({ summary, baseline: inventoryBaseline, rows }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const lines = [
        '# Authorization endpoint inventory and coverage', '',
        'Inventory rows include concrete operations and unresolved dynamic families. Counts are not counts of endpoints proven secure. A request matched to a row does not establish complete role, resource, argument or alias coverage. Inspect the named assertions and their response summaries in report.json. Unexecuted operations remain visible.', '',
        `Router rows: ${summary.routerRows}. Agent rows: ${summary.agentRows}. Manifest agents: ${summary.agents} (${summary.enabledAgents} recorded enabled). Declared MCP tools: ${summary.declaredTools}. Rows with request contact: ${summary.contactedRows}. Unexercised rows: ${summary.unexercisedRows}.`, '',
        '| ID / tool | Method | Router path | Source | Anonymous | selfRegistered | Ordinary user | Admin | Coverage / tests |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map(row => `| ${[row.tool || row.id, row.method, row.path, row.source, row.expected?.anonymous, row.expected?.selfRegistered, row.expected?.user, row.expected?.admin, `${row.coverage}; ${row.tests.join(', ') || row.gap || row.notes || 'No assertion executed'}`].map(escape).join(' | ')} |`),
        '', '## Explicit run gaps', '', ...(report.gaps || []).map(gap => `- ${escape(gap.id)}: ${escape(gap.reason)}`), '',
    ];
    await fs.writeFile(path.join(output, 'endpoint-coverage.md'), lines.join('\n'), { flag: 'wx', mode: 0o600 });
    return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    assert.equal(process.argv[2], '--out', 'Usage: node coverage.mjs --out /absolute/evidence-directory');
    assert.ok(path.isAbsolute(process.argv[3] || ''));
    console.log(JSON.stringify(await writeCoverage(process.argv[3])));
}
