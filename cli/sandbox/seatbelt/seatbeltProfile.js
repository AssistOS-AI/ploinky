import fs from 'fs';
import path from 'path';
import {
    AGENTS_DEPS_CACHE_DIR,
    CODE_DIR,
    DEPS_DIR,
    PLOINKY_DIR,
    PROFILE_FILE,
    ROUTING_FILE,
    SECRETS_FILE,
    SERVERS_CONFIG_FILE,
    PLOINKY_WORKSPACE_ROOT,
} from '../../utils/config.js';
import {
    normalizeManifestVolumeHostPaths,
    resolveManifestVolumeHostPath,
} from '../../utils/runtime/manifestVolumePolicy.js';
import { protectedLegacyAgentRoots } from '../../utils/runtime/legacyAgentDataGuards.js';
import { projectedCanonicalPath } from '../../utils/runtime/agentDataPathPolicy.js';

const SEATBELT_PROFILES_DIR = path.join(PLOINKY_DIR, 'seatbelt-profiles');

/**
 * Build an SBPL (Seatbelt Profile Language) string for sandbox-exec.
 *
 * Unlike bwrap which creates a virtual filesystem via bind mounts,
 * sandbox-exec uses macOS's Seatbelt framework to restrict filesystem
 * access at the kernel level.  Processes see real host paths.
 */
function buildSeatbeltProfile(options) {
    const {
        agentCodePath,
        agentLibPath,
        nodeModulesDir,
        agentWorkDir,
        sharedDir,
        cwd,
        skillsPath,
        codeReadOnly,
        skillsReadOnly,
        volumes,
        volumeOptions = {},
        workspaceRoot = PLOINKY_WORKSPACE_ROOT,
        extraReadPaths = [],
        extraWritePaths = [],
        agentLibGrant: grant = null,
    } = options;

    if (!grant) {
        throw new Error('[seatbelt] profile generation requires the selected achillesAgentLib grant');
    }

    const normalizedExtraWritePaths = normalizePathList(extraWritePaths);
    const normalizedVolumes = normalizeManifestVolumeHostPaths(volumes, {
        workspaceRoot,
        ploinkyDir: path.join(workspaceRoot, '.ploinky'),
    });
    const volumeAccess = Object.entries(volumes || {}).map(([hostPath, containerPath]) => {
        const options = volumeOptions[containerPath]
            || volumeOptions[String(containerPath || '').replace(/\/+$/, '')]
            || {};
        return {
            hostPath: resolveManifestVolumeHostPath(hostPath, workspaceRoot),
            readOnly: options.readOnly === true,
        };
    });
    const writableVolumes = volumeAccess.filter(entry => !entry.readOnly).map(entry => entry.hostPath);
    const protectedLegacyRoots = Array.from(new Set(
        protectedLegacyAgentRoots(workspaceRoot).flatMap(entry => [
            entry.hostPath,
            projectedCanonicalPath(entry.hostPath),
        ]),
    ));
    const protectedWritePaths = [
        ...collectProtectedWritePaths({
        agentCodePath,
        agentLibPath,
        nodeModulesDir,
        agentWorkDir,
        skillsPath,
        codeReadOnly,
        skillsReadOnly,
        }),
        ...volumeAccess.filter(entry => entry.readOnly).map(entry => ({ kind: 'subpath', path: entry.hostPath })),
        // Seatbelt creates no mount namespace, so the selected achillesAgentLib
        // source cannot be shadowed by a read-only bind. The write denial is
        // path-based and therefore applies through every workspace alias that
        // reaches the same directory.
        { kind: 'subpath', path: grant.sourceDir },
        ...protectedLegacyRoots.map(value => ({ kind: 'subpath', path: value })),
    ];
    const lines = [];
    lines.push('(version 1)');
    lines.push('(deny default)');
    lines.push('');

    const systemReadPaths = [
        '/usr',
        '/System',
        '/Library',
        '/Applications',
        '/private',
        '/dev',
        '/var',
        '/etc',
        '/tmp',
        '/bin',
        '/sbin'
    ];
    const scopedReadPaths = [
        ...systemReadPaths,
        agentLibPath,
        agentCodePath,
        nodeModulesDir,
        agentWorkDir,
        sharedDir,
        cwd,
        grant.sourceDir,
        ...(skillsPath && fs.existsSync(skillsPath) ? [skillsPath] : []),
        ...normalizedVolumes,
        ...normalizePathList(extraReadPaths),
        ...normalizedExtraWritePaths
    ];

    lines.push('; System read access');
    lines.push('(allow file-read*');
    for (const literalPath of collectLiteralPathAccess(scopedReadPaths)) {
        lines.push(`    (literal ${sbplQuote(literalPath)})`);
    }
    for (const readPath of scopedReadPaths) {
        lines.push(`    (subpath ${sbplQuote(readPath)})`);
    }
    lines.push(')');
    lines.push('');

    // Temp write access (HOME=/tmp for agents)
    lines.push('; Temp write access');
    lines.push('(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))');
    lines.push('(allow file-write* (literal "/dev/null"))');
    lines.push('');

    if (normalizedExtraWritePaths.length) {
        lines.push('; Additional write paths');
        for (const writePath of normalizedExtraWritePaths) {
            lines.push(`(allow file-write* (subpath ${sbplQuote(writePath)}))`);
        }
        lines.push('');
    }

    // Full network (agents use host network)
    lines.push('; Network access');
    lines.push('(allow network*)');
    lines.push('');

    // Process operations + Mach IPC (required on macOS)
    lines.push('; Process and IPC');
    // `process-exec*` already covers exec, and newer macOS sandboxes reject
    // declaring both `process-exec` and `process-exec*` in the same rule.
    lines.push('(allow process-fork process-exec*)');
    lines.push('(allow mach-lookup mach-register)');
    lines.push('(allow ipc-posix* signal sysctl-read)');
    lines.push('');

    // Agent library (always read-only)
    lines.push('; Agent library (read-only)');
    lines.push(`; covered by read access block: ${agentLibPath}`);
    lines.push('');

    // Agent code directory
    lines.push('; Agent code');
    if (!codeReadOnly) {
        lines.push(`(allow file-write* (subpath ${sbplQuote(agentCodePath)}))`);
    }
    lines.push('');

    // node_modules — read-only prepared cache (see dependencyCache.js)
    lines.push('; node_modules (read-only prepared cache)');
    lines.push(`; covered by read access block: ${nodeModulesDir}`);
    lines.push('');

    // Shared directory
    lines.push('; Shared directory');
    lines.push(`(allow file-write* (subpath ${sbplQuote(sharedDir)}))`);
    lines.push('');

    // Agent work directory
    if (agentWorkDir) {
        lines.push('; Agent work directory');
        lines.push(`(allow file-write* (subpath ${sbplQuote(agentWorkDir)}))`);
        lines.push('');
    }

    // CWD passthrough (user workspace root). Protected Ploinky internals are
    // denied below so this does not bypass read-only code/dependency mounts.
    lines.push('; Workspace directory');
    lines.push(`(allow file-write* (subpath ${sbplQuote(cwd)}))`);
    lines.push('');

    // Skills directory
    if (skillsPath && fs.existsSync(skillsPath)) {
        lines.push('; Skills directory');
        if (!skillsReadOnly) {
            lines.push(`(allow file-write* (subpath ${sbplQuote(skillsPath)}))`);
        }
        lines.push('');
    }

    // Custom volumes from manifest
    if (volumes && typeof volumes === 'object') {
        const volumeEntries = Object.entries(volumes);
        if (volumeEntries.length) {
            lines.push('; Custom volumes');
            for (const resolvedHostPath of writableVolumes) {
                lines.push(`(allow file-write* (subpath ${sbplQuote(resolvedHostPath)}))`);
            }
            lines.push('');
        }
    }

    if (protectedWritePaths.length) {
        lines.push('; Protected runtime paths');
        lines.push('(deny file-write*');
        for (const protectedPath of protectedWritePaths) {
            lines.push(`    (${protectedPath.kind} ${sbplQuote(protectedPath.path)})`);
        }
        lines.push(')');
        lines.push('');
    }

    lines.push('; Protected legacy agent data is opaque even through a broad workspace grant');
    lines.push('(deny file-read*');
    for (const protectedRoot of protectedLegacyRoots) {
        lines.push(`    (subpath ${sbplQuote(protectedRoot)})`);
    }
    lines.push(')');
    lines.push('');

    return lines.join('\n') + '\n';
}

function normalizePathList(paths) {
    if (!Array.isArray(paths)) return [];
    return Array.from(new Set(paths
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => path.resolve(value))));
}

function collectProtectedWritePaths({
    agentCodePath,
    agentLibPath,
    nodeModulesDir,
    agentWorkDir,
    skillsPath,
    codeReadOnly,
    skillsReadOnly,
}) {
    const entries = [];
    const addSubpath = (value) => {
        if (!value || typeof value !== 'string') return;
        entries.push({ kind: 'subpath', path: path.resolve(value) });
    };
    const addLiteral = (value) => {
        if (!value || typeof value !== 'string') return;
        entries.push({ kind: 'literal', path: path.resolve(value) });
    };

    const nodeModulesParent = nodeModulesDir ? path.dirname(nodeModulesDir) : '';
    if (nodeModulesParent && path.resolve(nodeModulesParent) !== path.resolve(agentWorkDir || '')) {
        addSubpath(nodeModulesParent);
    }
    addSubpath(DEPS_DIR);
    addSubpath(AGENTS_DEPS_CACHE_DIR);
    addSubpath(path.join(agentCodePath || '', 'node_modules'));
    addSubpath(agentLibPath);
    addSubpath(path.join(PLOINKY_DIR, 'seatbelt-runtime'));
    addSubpath(CODE_DIR);

    if (codeReadOnly) {
        addSubpath(agentCodePath);
    }
    if (skillsReadOnly && skillsPath && fs.existsSync(skillsPath)) {
        addSubpath(skillsPath);
    }

    addLiteral(SECRETS_FILE);
    addLiteral(PROFILE_FILE);
    addLiteral(ROUTING_FILE);
    addLiteral(SERVERS_CONFIG_FILE);

    return dedupePathRules(entries.filter(({ path: value }) => value && value !== path.dirname(value)));
}

function dedupePathRules(entries) {
    const seen = new Set();
    const result = [];
    for (const entry of entries) {
        const key = `${entry.kind}:${entry.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(entry);
    }
    return result;
}

function collectLiteralPathAccess(paths) {
    const literals = new Set(['/']);
    for (const readPath of normalizePathList(paths)) {
        let current = path.resolve(readPath);
        const chain = [];
        while (current && current !== '/') {
            chain.push(current);
            current = path.dirname(current);
        }
        for (let index = chain.length - 1; index >= 0; index -= 1) {
            literals.add(chain[index]);
        }
    }
    return Array.from(literals);
}

/**
 * Quote a path for SBPL (Seatbelt Profile Language).
 * Paths are quoted with double quotes.
 */
function sbplQuote(str) {
    return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Write a seatbelt profile to disk.
 * Returns the file path.
 */
function writeSeatbeltProfile(agentName, content) {
    if (!fs.existsSync(SEATBELT_PROFILES_DIR)) {
        fs.mkdirSync(SEATBELT_PROFILES_DIR, { recursive: true });
    }
    const profilePath = path.join(SEATBELT_PROFILES_DIR, `${agentName}.sb`);
    fs.writeFileSync(profilePath, content, 'utf8');
    return profilePath;
}

export {
    SEATBELT_PROFILES_DIR,
    buildSeatbeltProfile,
    writeSeatbeltProfile,
    collectLiteralPathAccess
};
