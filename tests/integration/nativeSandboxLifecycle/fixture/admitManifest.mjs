// Admits the fixture manifest with the selected checkout's real direct-agent
// admission API and prints the runtime it selects.
//
// usage: node admitManifest.mjs <ploinky checkout> <manifest path> <repo/agent>
import fs from 'node:fs';

const [source, manifestPath, agentId] = process.argv.slice(2);
if (!source || !manifestPath || !agentId) {
    console.error('usage: admitManifest.mjs <ploinky checkout> <manifest path> <repo/agent>');
    process.exit(64);
}
const { bootstrapAgentLibRuntime } = await import(`${source}/agentlib/bootstrap.mjs`);
await bootstrapAgentLibRuntime({ cwd: process.cwd() });
const { admitDirectAgentRuntimeManifest } = await import(`${source}/cli/commands/workspaceUtil.js`);
const manifestBytes = fs.readFileSync(manifestPath);
const admission = admitDirectAgentRuntimeManifest(JSON.parse(manifestBytes.toString('utf8')), {
    manifestPath,
    manifestBytes,
    agentId,
});
console.log(JSON.stringify({
    runtime: admission.runtime,
    runtimeKind: admission.runtimeKind,
    profile: admission.profileResolution.resolvedProfileName,
    network: admission.profileResolution.network,
}));
