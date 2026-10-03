// Runtime checks for the MCP SDK the Box image supplies.
//
// The image build owns selecting, packaging and describing the SDK. Ploinky only
// checks that the copy is a usable package - the right package, its declared
// entry point present, and a plain file tree - and identifies it by the
// immutable Box image that supplies it. It never hashes SDK bytes and never
// compares the copy with a revision Ploinky expects.

import fs from 'node:fs';
import path from 'node:path';

import {
    AGENTLIB_ERROR_CODES,
    agentLibError,
    assertSupplyingImageId,
    normalizeLibraryProvenance,
} from '../agentlib/contract.mjs';

/** The name Ploinky imports and provides the SDK under. */
export const MCP_SDK_LIBRARY_NAME = 'mcp-sdk';
export const MCP_SDK_BUNDLE_PATH = '/usr/local/lib/ploinky/mcp-sdk';
export const MCP_SDK_BUNDLE_METADATA_NAME = '.ploinky-box-mcp-sdk.json';
export const MCP_SDK_METADATA_SCHEMA = 'ploinky.box.library/v1';
export const MCP_SDK_PACKAGE_NAME = '@modelcontextprotocol/sdk';
/**
 * Repository identity used to recognize a dependency that would duplicate the
 * provided SDK. It identifies the package and never selects a commit.
 */
export const MCP_SDK_REPOSITORY_URL = 'https://github.com/AssistOS-AI/MCPSDK.git';

function bundleError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'PLOINKY_BOX_MCP_SDK_BUNDLE_FAILED';
    return error;
}

function assertRealDirectory(directory, fsApi) {
    let stat;
    try {
        stat = fsApi.lstatSync(directory);
    } catch (error) {
        throw bundleError(`MCP SDK bundle directory is missing: ${directory}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw bundleError(`MCP SDK bundle path is not a real directory: ${directory}`);
    }
}

function readJsonFile(filename, fsApi, description) {
    try {
        const stat = fsApi.lstatSync(filename);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            throw bundleError(`${description} is not a regular file: ${filename}`);
        }
        return JSON.parse(fsApi.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error?.code === 'PLOINKY_BOX_MCP_SDK_BUNDLE_FAILED') throw error;
        throw bundleError(`Unable to read ${description}: ${filename}`, error);
    }
}

/** The file `exports["."]` names, whether a plain string or a condition map. */
function entryTarget(pkg) {
    const declared = pkg?.exports?.['.'];
    const pick = (value) => {
        if (typeof value === 'string') return value;
        if (!value || typeof value !== 'object') return null;
        for (const condition of ['import', 'default', 'node', 'require']) {
            const found = pick(value[condition]);
            if (found) return found;
        }
        return null;
    };
    return pick(declared);
}

/**
 * Check the SDK package: the expected package name and version, and a present,
 * contained entry point. No revision, repository or content is compared.
 *
 * @returns {Readonly<{sourceRoot: string, packageName: string, packageVersion: string, entry: string}>}
 */
export function readMcpSdkPackage({ sourceRoot = MCP_SDK_BUNDLE_PATH, fsApi = fs } = {}) {
    const root = path.resolve(sourceRoot);
    assertRealDirectory(root, fsApi);
    const pkg = readJsonFile(path.join(root, 'package.json'), fsApi, 'MCP SDK package.json');
    if (pkg?.name !== MCP_SDK_PACKAGE_NAME
        || typeof pkg.version !== 'string'
        || !pkg.version.trim()) {
        throw bundleError(`MCP SDK bundle must contain ${MCP_SDK_PACKAGE_NAME}`);
    }
    const target = entryTarget(pkg);
    if (!target) throw bundleError('The MCP SDK package declares no exports["."] entry point');
    const entry = path.resolve(root, target);
    if (entry !== root && !entry.startsWith(`${root}${path.sep}`)) {
        throw bundleError(`The MCP SDK entry point ${target} is outside the package`);
    }
    let entryStat;
    try {
        entryStat = fsApi.lstatSync(entry);
    } catch (error) {
        throw bundleError(`The MCP SDK entry point ${target} is missing`, error);
    }
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
        throw bundleError(`The MCP SDK entry point ${target} is not a regular file`);
    }
    return Object.freeze({
        sourceRoot: root,
        packageName: pkg.name,
        packageVersion: pkg.version,
        entry: path.relative(root, entry).split(path.sep).join('/'),
    });
}

/**
 * The plain file tree of a supplied or copied SDK: no symlinks, no Git
 * metadata, only regular files. This walks entries and never reads file bytes.
 */
export function assertMcpSdkTree(sourceRoot, fsApi = fs) {
    const root = path.resolve(sourceRoot);
    assertRealDirectory(root, fsApi);
    const visit = (directory, relativeDirectory = '') => {
        for (const name of fsApi.readdirSync(directory).sort()) {
            if (!relativeDirectory && name === '.git') {
                throw bundleError('MCP SDK image bundle must not contain Git metadata');
            }
            const absolute = path.join(directory, name);
            const relative = path.posix.join(relativeDirectory, name);
            const stat = fsApi.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                throw bundleError(`MCP SDK image bundle must not contain symlinks: ${relative}`);
            }
            if (stat.isDirectory()) {
                visit(absolute, relative);
                continue;
            }
            if (!stat.isFile() || stat.nlink !== 1) {
                throw bundleError(`MCP SDK image bundle contains a non-regular file: ${relative}`);
            }
        }
    };
    visit(root);
}

/**
 * Build-generated provenance of the SDK copy, or all-null when the record is
 * absent or not in the current format. It is diagnostic information only.
 */
export function readMcpSdkProvenance({ sourceRoot = MCP_SDK_BUNDLE_PATH, fsApi = fs } = {}) {
    try {
        const metadata = readJsonFile(
            path.join(path.resolve(sourceRoot), MCP_SDK_BUNDLE_METADATA_NAME), fsApi, 'MCP SDK bundle metadata',
        );
        if (metadata?.schema !== MCP_SDK_METADATA_SCHEMA || metadata?.library !== MCP_SDK_LIBRARY_NAME) {
            return normalizeLibraryProvenance(null);
        }
        return normalizeLibraryProvenance(metadata);
    } catch (_) {
        return normalizeLibraryProvenance(null);
    }
}

/**
 * The identity of the SDK a Box supplies: the immutable outer Box image that
 * carries it, plus the library name. Nested agent images never appear here.
 */
export function mcpSdkIdentity(supplyingImageId) {
    let imageId;
    try {
        imageId = assertSupplyingImageId(supplyingImageId, 'MCP SDK supplying image ID');
    } catch (error) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid, error.message, { cause: error });
    }
    return Object.freeze({ kind: 'image', library: MCP_SDK_LIBRARY_NAME, supplyingImageId: imageId });
}
