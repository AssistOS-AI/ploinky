// Initializes the four fresh edge-routing source files through the selected
// checkout's own API, with the checkout's own AgentLib bootstrap. The runner
// calls it before `enable sandbox`: that command writes `.ploinky/agents.json`
// first, and a later `start` refuses a workspace that holds only some of the
// sources ("edge routing sources are incomplete").
//
// usage: node initEdgeSources.mjs <ploinky checkout>
const source = process.argv[2];
if (!source) {
    console.error('usage: initEdgeSources.mjs <ploinky checkout>');
    process.exit(64);
}
const { bootstrapAgentLibRuntime } = await import(`${source}/agentlib/bootstrap.mjs`);
await bootstrapAgentLibRuntime({ cwd: process.cwd() });
const { initializeFreshEdgeRoutingSources } = await import(`${source}/cli/sandbox/edgeGeneration.js`);
const result = initializeFreshEdgeRoutingSources({ workspaceRoot: process.cwd() });
console.log(JSON.stringify({ initialized: result.initialized }));
