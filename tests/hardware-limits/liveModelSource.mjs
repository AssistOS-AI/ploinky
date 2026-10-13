// Read-only proof of Podman's linked /code stage. Source bytes and the
// dependency substitution remain bound to the exact owned runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fixtureContainerName } from './liveFixture.mjs';
import { canonicalDigest } from '../../cli/utils/dependencies/store/canonical.mjs';
import { hashInstalledTree } from '../../cli/utils/dependencies/store/treeHash.mjs';
import { buildResolutionManifest, readHiddenLock } from '../../cli/utils/dependencies/store/resolution.mjs';
import { boxMcpSdkCacheProblem } from '../../ploinky-box/agent-dependencies/mcp-sdk.mjs';
import { runtimeSegment } from '../../cli/utils/runtime/runtimeStaging.js';
import { agentLibContractFromContainer } from '../../ploinky-box/contract/agentlib.mjs';

const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const under = (value, root) => value === root || value.startsWith(`${root}/`);
const managed = value => /(?:^|\/)\.ploinky\/repos(?:\/|$)/.test(String(value));
const sameImage = (left, right) => String(left).replace(/^sha256:/, '') === String(right).replace(/^sha256:/, '');
const providerPath = '/opt/ploinky-agentlib';

function validateMounts(mounts) {
    check(Array.isArray(mounts) && mounts.length <= 128 && mounts.every(mount => mount && ['Source', 'Destination'].every(key =>
        typeof mount[key] === 'string' && path.isAbsolute(mount[key]) && path.normalize(mount[key]) === mount[key]
        && mount[key].length <= 2048 && !/[\0\n]/.test(mount[key]))), 'Model mount observation is malformed or exceeds its bound');
}

export function modelSourceLayout(profile, agent) {
    validateMounts(agent.mounts);
    const workspace = profile.workspace.path;
    const source = path.join(workspace, 'local-llms', 'local-llm');
    const name = fixtureContainerName(workspace, 'local-llm', 'local-llms');
    const root = path.join(workspace, '.ploinky', 'container-runtime', runtimeSegment(name));
    const code = agent.mounts.filter(mount => mount.Destination === '/code');
    check(code.length === 1 && code[0].Type === 'bind' && code[0].RW === false
        && path.dirname(code[0].Source || '') === root && /^code-[1-9][0-9]*-[1-9][0-9]*$/.test(path.basename(code[0].Source)), 'Model /code is not the exact owned read-only staging bind');
    const self = agent.mounts.filter(mount => mount.Destination === source);
    check(self.length === 1 && self[0].Type === 'bind' && self[0].Source === source && self[0].RW === false, 'Model ordinary source lacks its exact read-only self-bind');
    check(!agent.mounts.some(mount => mount.Destination.startsWith('/code/') || mount.Destination.startsWith(`${source}/`)
        || under(mount.Destination, code[0].Source)), 'Model source has an unexpected descendant mount');
    const provider = agent.mounts.filter(mount => mount.Destination === providerPath);
    check(provider.length === 1 && provider[0].Type === 'bind' && provider[0].Source === providerPath && provider[0].RW === false
        && !agent.mounts.some(mount => mount.Destination.startsWith(`${providerPath}/`)), 'Model provider lacks its exact read-only self-bind or has a descendant overlay');
    return { workspace, source, name, root, stage: code[0].Source };
}

export const modelMountFacts = value => ({ id: value.id, image: value.image, created: value.created, mountCount: value.mounts?.length ?? null,
    mounts: Array.isArray(value.mounts) ? value.mounts.slice(0, 128).map(mount => ({ Type: mount.Type, Source: mount.Source, Destination: mount.Destination, RW: mount.RW })) : null });

function modelProvider(profile, box) {
    check(box && box.id === profile.box.id && box.created === profile.box.created && sameImage(box.image, profile.box.image)
        && box.running === true, 'Model provider Box identity changed');
    validateMounts(box.mounts);
    // Image mode has no host provider bind. Any covering mount changes that
    // origin, even if its bytes or labels happen to match the selected image.
    check(!box.mounts.some(mount => mount.Destination === '/' || under(mount.Destination, providerPath)
        || under(providerPath, mount.Destination)), 'Model provider image has an ancestor, exact or descendant mount override');
    const contract = agentLibContractFromContainer({ labels: box.labels, runtime: { imageId: box.image,
        mounts: box.mounts.map(mount => ({ source: mount.Source, destination: mount.Destination, rw: mount.RW })) } });
    check(contract.mode === 'image' && sameImage(contract.supplyingImageId, profile.box.image), 'Model provider is not the pinned image selection');
    return { mode: contract.mode, path: contract.stablePath, sourceIdHash: contract.sourceIdHash,
        supplyingImageId: contract.supplyingImageId, boxId: box.id };
}

function boundedFs() {
    let entries = 0; let bytes = 0;
    const reads = new Set(['readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'readlinkSync', 'existsSync', 'realpathSync']);
    return new Proxy(fs, { get(target, key) {
        if (typeof target[key] !== 'function') return target[key];
        check(reads.has(key), 'Source proof attempted a filesystem mutation');
        return (file, ...args) => {
            check(typeof file === 'string' && !managed(file), 'Source proof refuses managed-repository access');
            check(++entries <= 50000, 'Source proof filesystem observation bound exceeded');
            if (key === 'readFileSync') {
                const stat = fs.lstatSync(file);
                check(stat.isFile() && !stat.isSymbolicLink(), 'Source proof refuses a linked metadata file');
                bytes += stat.size;
                check(bytes <= 512 * 1024 * 1024, 'Source proof byte bound exceeded');
            }
            return target[key](file, ...args);
        };
    } });
}

function canonicalDirectory(directory, workspace, io) {
    check(under(directory, workspace) && !managed(directory), 'Source proof directory escaped the owned workspace');
    let current = workspace;
    for (const part of ['', ...path.relative(workspace, directory).split('/').filter(Boolean)]) {
        if (part) current = path.join(current, part);
        const stat = io.lstatSync(current);
        check(stat.isDirectory() && !stat.isSymbolicLink(), 'Source proof directory has a symlink or wrong type');
    }
    check(io.realpathSync(directory) === directory, 'Source proof directory is not canonical');
}

// Use the store's pure hash/resolution/provider checks without importing its
// runtime installation module, which requires an active AgentLib environment.
function readDependencyObject(dep, layout, profile, agent, io) {
    const root = path.dirname(dep.payloadPath);
    const json = file => {
        try { return JSON.parse(io.readFileSync(file, 'utf8')); }
        catch { throw new Error('Model dependency metadata is unreadable'); }
    };
    const unusable = path.join(layout.workspace, '.ploinky', 'deps', 'store', 'state', 'unusable');
    try {
        canonicalDirectory(unusable, layout.workspace, io);
        check(!io.existsSync(path.join(unusable, `${dep.objectId}.json`)), 'Model dependency object is marked unusable');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const complete = json(path.join(root, 'complete.json'));
    const manifestBytes = io.readFileSync(path.join(root, 'manifest.json'));
    check(sha(manifestBytes) === complete.manifestSha256, 'Model dependency completion does not bind its manifest');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch { throw new Error('Model dependency metadata is unreadable'); }
    check(manifest.format === 'ploinky-deps-cache' && manifest.version === 1 && manifest.owner === 'ploinky-deps-store'
        && manifest.workspaceId === sha(layout.workspace) && manifest.objectId === dep.objectId && manifest.payloadPath === dep.payloadPath
        && complete.format === manifest.format && complete.version === 1 && complete.objectId === dep.objectId
        && manifest.inputKey === dep.inputKey && canonicalDigest(manifest.contract) === dep.inputKey, 'Model dependency object identity mismatch');
    const packageSource = manifest.contract?.agent?.packageSource;
    check(packageSource?.selection === 'root' && packageSource.relativePath === 'local-llms/local-llm/package.json'
        && packageSource.sha256 === sha(io.readFileSync(path.join(layout.source, 'package.json')))
        && sameImage(manifest.contract?.toolchain?.imageId, agent.image), 'Dependency object does not originate from the pinned source package and image');
    const providers = manifest.contract.providers;
    check(providers?.agentLib?.mode === 'image' && providers.agentLib.library === 'achillesAgentLib'
        && providers.agentLib.linkTarget === '/opt/ploinky-agentlib' && providers.agentLib.installTarget === '/opt/ploinky-agentlib'
        && sameImage(providers.agentLib.supplyingImageId, profile.box.image)
        && JSON.stringify(manifest.approvedExternalTargets) === JSON.stringify(['/opt/ploinky-agentlib'])
        && (providers.mcpSdk == null || providers.mcpSdk.kind === 'image' && providers.mcpSdk.library === 'mcp-sdk'
            && sameImage(providers.mcpSdk.supplyingImageId, profile.box.image)), 'Model dependency provider is not the pinned Box source');
    const tree = hashInstalledTree(dep.payloadPath, { approvedExternalTargets: ['/opt/ploinky-agentlib'], imageSdkProvider: Boolean(providers.mcpSdk), fsApi: io });
    const resolution = buildResolutionManifest(readHiddenLock(dep.payloadPath, { fsApi: io }), { installer: manifest.resolution?.installer || null });
    const generation = sha(`${dep.inputKey}\n${resolution.hash}\n${tree.hash}`);
    check(tree.hash === manifest.tree?.hash && resolution.hash === manifest.resolution?.hash && generation === dep.generationId
        && generation === manifest.generationId && generation === complete.generationId, 'Admitted model dependency object failed its read-only integrity check');
    check(!boxMcpSdkCacheProblem(dep.payloadPath, providers.mcpSdk ? { identity: providers.mcpSdk } : null), 'Model dependency SDK provider copy is invalid');
    return manifest;
}

export function observeModelStage(profile, agent, { box, write = () => {} } = {}) {
    const facts = { schema: 1, agent: modelMountFacts(agent), box: box ? modelMountFacts(box) : null, links: [] };
    const save = () => write(structuredClone(facts));
    save();
    try {
        const layout = modelSourceLayout(profile, agent);
        facts.provider = modelProvider(profile, box); save();
        const io = boundedFs();
        facts.layout = layout; save();
        canonicalDirectory(layout.stage, layout.workspace, io);
        canonicalDirectory(layout.source, layout.workspace, io);
        const stageNames = io.readdirSync(layout.stage).sort();
        facts.stageEntryCount = stageNames.length;
        facts.stageEntries = stageNames.slice(0, 256).map(name => {
            const file = path.join(layout.stage, name); const stat = io.lstatSync(file);
            return { name, symbolic: stat.isSymbolicLink(), targetDigest: stat.isSymbolicLink() ? sha(io.readlinkSync(file)) : null };
        });
        save();
        check(stageNames.length <= 256, 'Model staging observation exceeds its entry bound');
        const recordFile = path.join(layout.workspace, '.ploinky', 'agents.json');
        check(io.lstatSync(recordFile).size <= 4 * 1024 * 1024, 'Owned runtime record exceeds its bound');
        let record;
        try { record = JSON.parse(io.readFileSync(recordFile, 'utf8'))[layout.name]; }
        catch { throw new Error('Owned runtime record is unreadable'); }
        check(record?.containerId === agent.id && record.runtime === 'podman' && record.profile === 'default', 'Staged source runtime record names another container or profile');
        const binds = record.config?.binds;
        const recorded = target => Array.isArray(binds) ? binds.filter(bind => bind.target === target) : [];
        for (const [target, source] of [['/code', layout.stage], [layout.source, layout.source]]) {
            const matches = recorded(target);
            check(matches.length === 1 && matches[0].source === source && matches[0].ro === true, 'Recorded source binding differs from the runtime mount');
        }
        const providerBinds = recorded(providerPath);
        check(providerBinds.length === 1 && providerBinds[0].source === providerPath && providerBinds[0].ro === true
            && !binds.some(bind => typeof bind.target === 'string' && bind.target.startsWith(`${providerPath}/`)), 'Recorded model provider differs from the runtime mount');
        const dep = record.dependencies;
        check(dep?.schema === 1 && dep.mode === 'store' && dep.family === 'container' && sameImage(dep.imageId, agent.image)
            && /^[a-f0-9]{64}$/.test(dep.inputKey) && /^[a-f0-9]{64}$/.test(dep.generationId)
            && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(dep.objectId), 'Model dependency identity is not the admitted immutable object');
        const payload = path.join(layout.workspace, '.ploinky', 'deps', 'store', 'objects', dep.objectId, 'payload');
        const dependency = path.join(payload, 'node_modules');
        check(dep.payloadPath === payload && dep.nodeModulesPath === dependency, 'Model dependency payload path differs from its owned object');
        canonicalDirectory(dependency, layout.workspace, io);
        const mounted = agent.mounts.filter(mount => mount.Destination === dependency);
        check(mounted.length === 1 && mounted[0].Type === 'bind' && mounted[0].Source === dependency && mounted[0].RW === false
            && !agent.mounts.some(mount => mount.Destination.startsWith(`${dependency}/`)), 'Model dependencies lack their exact read-only self-bind');
        const depBinds = recorded(dependency);
        check(depBinds.length === 1 && depBinds[0].source === dependency && depBinds[0].ro === true, 'Recorded dependency mount differs from the runtime mount');
        const object = readDependencyObject(dep, layout, profile, agent, io);
        check(object.contract.providers.agentLib.sourceIdHash === facts.provider.sourceIdHash, 'Model dependency provider identity differs from its Box origin');
        facts.dependency = { objectId: dep.objectId, generationId: dep.generationId, inputKey: dep.inputKey, nodeModulesPath: dependency,
            treeDigest: object.tree.hash, packageSha256: object.contract.agent.packageSource.sha256 };
        const manifest = JSON.parse(io.readFileSync(path.join(layout.source, 'manifest.json'), 'utf8'));
        // The pinned model agent has no code-volume overrides. Refuse a new
        // layout until its substitution policy is deliberately reviewed.
        const volumes = Object.entries({ ...(manifest.volumes || {}), ...(manifest.profiles?.default?.volumes || {}) });
        facts.volumes = [];
        for (const [from, target] of volumes) {
            check(typeof target === 'string' && !under(target, '/code') && /^\.data\/[A-Za-z0-9_./-]+$/.test(from), 'Unreviewed model code or volume substitution');
            const source = path.resolve(layout.workspace, from);
            check(under(source, path.join(layout.workspace, '.data')), 'Model volume escaped task data');
            const mounts = agent.mounts.filter(mount => mount.Destination === target);
            const readOnly = ({ ...(manifest.volumeOptions || {}), ...(manifest.profiles?.default?.volumeOptions || {}) })[target]?.readOnly === true;
            check(mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].Source === source && mounts[0].RW === !readOnly, 'Declared model volume differs from its runtime bind');
            facts.volumes.push({ source, target, readOnly });
        }
        const names = io.readdirSync(layout.source).sort();
        check(!names.includes('node_modules') && !names.includes('.git'), 'Pinned model source contains an unreviewed code substitution');
        check(JSON.stringify(io.readdirSync(layout.stage).sort()) === JSON.stringify([...names, 'node_modules'].sort()), 'Model staging entries differ from the pinned source and admitted dependency');
        for (const name of [...names, 'node_modules']) {
            const file = path.join(layout.stage, name);
            const expected = name === 'node_modules' ? dependency : path.join(layout.source, name);
            const stat = io.lstatSync(file);
            const target = stat.isSymbolicLink() ? io.readlinkSync(file) : null;
            facts.links.push({ name, symbolic: stat.isSymbolicLink(), targetMatches: target === expected, targetDigest: target === null ? null : sha(target) }); save();
            check(stat.isSymbolicLink() && target === expected, 'Model stage entry does not point to its pinned origin');
            // Only resolve after the literal link has matched an allowed origin.
            check(io.realpathSync(file) === expected, 'Model stage entry resolves away from its pinned origin');
        }
        facts.complete = true; save();
        return { ...facts, view: { source: layout.source, dependency } };
    } catch (error) {
        facts.complete = false; facts.problem = String(error?.message || error).slice(0, 300); save();
        throw error;
    }
}

// Also run inside the actual agent namespace. No environment, record contents
// or source bodies leave the process: only selected link facts and hashes.
export function observeModelCodeView({ source, dependency, codeRoot = '/code' }, io = fs) {
    const facts = { schema: 1, links: [], files: [], complete: false };
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
    const allowed = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/(?:^|\/)\.ploinky\/repos(?:\/|$)/.test(value);
    let count = 0; let bytes = 0;
    try {
        assert(allowed(source) && allowed(dependency) && allowed(codeRoot), 'Invalid model namespace source paths');
        assert(io.realpathSync(source) === source && io.lstatSync(codeRoot).isDirectory() && !io.lstatSync(codeRoot).isSymbolicLink(), 'Model namespace roots changed');
        const names = io.readdirSync(source).sort();
        assert(!names.includes('node_modules') && !names.includes('.git') && names.length <= 256, 'Model namespace source entry bound or substitution changed');
        const codeNames = io.readdirSync(codeRoot).sort();
        facts.entryCount = codeNames.length; facts.entryNames = codeNames.slice(0, 256);
        assert(JSON.stringify(codeNames) === JSON.stringify([...names, 'node_modules'].sort()), 'Model namespace staging entries changed');
        for (const name of [...names, 'node_modules']) {
            const file = path.join(codeRoot, name);
            const expected = name === 'node_modules' ? dependency : path.join(source, name);
            const stat = io.lstatSync(file); const target = stat.isSymbolicLink() ? io.readlinkSync(file) : null;
            facts.links.push({ name, symbolic: stat.isSymbolicLink(), targetMatches: target === expected, targetDigest: target === null ? null : hash(target) });
            assert(stat.isSymbolicLink() && target === expected, 'Model namespace link has an unpinned origin');
            assert(io.realpathSync(file) === expected, 'Model namespace link resolves to another origin');
        }
        const provider = '/opt/ploinky-agentlib';
        const providerLink = path.join(codeRoot, 'node_modules', 'achillesAgentLib');
        const linkStat = io.lstatSync(providerLink);
        const target = linkStat.isSymbolicLink() ? io.readlinkSync(providerLink) : null;
        facts.provider = { path: provider, symbolic: linkStat.isSymbolicLink(), targetMatches: target === provider };
        assert(linkStat.isSymbolicLink() && target === provider, 'Model namespace provider link has an unpinned origin');
        const providerStat = io.lstatSync(provider);
        assert(providerStat.isDirectory() && !providerStat.isSymbolicLink() && io.realpathSync(provider) === provider
            && io.realpathSync(providerLink) === provider, 'Model namespace provider resolution changed');
        facts.provider.resolved = true;
        const rows = [];
        const walk = (directory, relative = '') => {
            for (const name of io.readdirSync(directory).sort()) {
                assert(++count <= 4096, 'Model namespace source entry bound exceeded');
                const rel = relative ? `${relative}/${name}` : name;
                const original = path.join(source, rel); const file = path.join(codeRoot, rel);
                const stat = io.lstatSync(original);
                assert(!stat.isSymbolicLink() && io.realpathSync(file) === original, 'Model namespace source resolution changed');
                if (stat.isDirectory()) walk(original, rel);
                else {
                    assert(stat.isFile(), 'Model namespace source entry has an invalid type');
                    bytes += stat.size; assert(bytes <= 64 * 1024 * 1024, 'Model namespace source byte bound exceeded');
                    const fileHash = hash(io.readFileSync(file));
                    facts.files.push({ path: rel, sha256: fileHash });
                    rows.push(`${rel}\0sha256:${fileHash}`);
                }
            }
        };
        walk(source);
        facts.treeDigest = `sha256:${hash(rows.join('\n'))}`; facts.bytes = bytes; facts.complete = true;
    } catch (error) { facts.problem = String(error?.message || error).slice(0, 300); }
    return facts;
}

export const MODEL_SOURCE_VIEW = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');\nconst observe=${observeModelCodeView.toString()};\nconst input=process.argv[1];if(Buffer.byteLength(input||'')>4096)throw Error('Model source arguments exceed bound');process.stdout.write(JSON.stringify(observe(JSON.parse(input))));`;
