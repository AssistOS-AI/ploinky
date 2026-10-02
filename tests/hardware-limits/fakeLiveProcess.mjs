// The file-backed fake world as real executables, so a test can drive the
// runner's real process path (runBoundedProcess, no injected provider). A
// pinned fake engine binary and the fixture candidate's ploinky-box.mjs each
// call runFakeProcess with the world configuration beside them; every call is
// interpreted by createFakeWorld exactly as the in-process provider would be.
// Test support only: no real engine, SSH, GPU or network is touched.
import fs from 'node:fs';
import { createFakeWorld } from './fakeLiveEngine.mjs';

export async function runFakeProcess(configPath, role) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const provider = createFakeWorld({ statePath: config.statePath, node: config.node, engine: config.engine, host: config.host, unrelated: config.unrelated || [], faults: config.faults || {} });
    const binary = role === 'node' ? config.node : config.engine;
    const args = role === 'node' ? [config.candidate, ...process.argv.slice(2)] : process.argv.slice(2);
    const result = await provider(binary, args, { cwd: process.cwd(), env: process.env });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.status;
}

// Write the executables: an engine binary and the candidate entry point.
export function writeFakeExecutables({ configPath, enginePath, candidatePath, node = process.execPath }) {
    const module = new URL('./fakeLiveProcess.mjs', import.meta.url).href;
    fs.writeFileSync(enginePath, `#!${node}\nimport(${JSON.stringify(module)}).then((m) => m.runFakeProcess(${JSON.stringify(configPath)}, 'engine'));\n`, { mode: 0o755 });
    fs.writeFileSync(candidatePath, `import { runFakeProcess } from ${JSON.stringify(module)};\nawait runFakeProcess(${JSON.stringify(configPath)}, 'node');\n`, { mode: 0o644 });
}
