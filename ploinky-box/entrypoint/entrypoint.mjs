#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOX_READY_LINE, BOX_RUNTIME_CONTRACT } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createProcessRunner } from '../process.mjs';
import { initializeWorkspaceMasterKey } from './initialize-workspace.mjs';
import { installPinnedDependencies } from './install-dependencies.mjs';
import { configureBoxTransport } from './transport.mjs';

function entrypointError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_ENTRYPOINT_FAILED',
        cause,
    });
}

function rooted(root, productionPath) {
    const selectedRoot = path.resolve(root);
    return selectedRoot === '/'
        ? productionPath
        : path.join(selectedRoot, productionPath.replace(/^\/+/, ''));
}

export function entrypointPaths(root = '/') {
    return Object.freeze({
        contract: rooted(root, '/etc/ploinky-box'),
        workspace: rooted(root, '/workspace'),
        dependencies: rooted(root, '/opt/ploinky/node_modules'),
        ploinky: rooted(root, '/opt/ploinky/bin/ploinky'),
        nestedStore: rooted(root, '/home/podman/.local/share/containers'),
        transport: rooted(root, '/run/ploinky/box-transport.json'),
        containersConf: rooted(root, '/home/podman/.config/containers/containers.conf'),
        tmp: rooted(root, '/tmp'),
    });
}

export function verifyEntrypointContract(contractPath, fsApi = fs) {
    let stat;
    let bytes;
    try {
        stat = fsApi.lstatSync(contractPath);
        bytes = fsApi.readFileSync(contractPath);
    } catch (error) {
        throw entrypointError(`Unable to read runtime contract marker ${contractPath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
        || !bytes.equals(Buffer.from(`${BOX_RUNTIME_CONTRACT}\n`))) {
        throw entrypointError(`Runtime contract marker must contain exactly ${BOX_RUNTIME_CONTRACT}`);
    }
}

function assertDirectory(target, { writable = false } = {}, fsApi = fs) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw entrypointError(`Required mount target is not a real directory: ${target}`);
    }
    if (writable) fsApi.accessSync(target, fsApi.constants.W_OK);
}

export function validateEntrypointMounts(paths, fsApi = fs) {
    try {
        assertDirectory(paths.workspace, { writable: true }, fsApi);
        assertDirectory(paths.dependencies, { writable: true }, fsApi);
        assertDirectory(paths.nestedStore, { writable: true }, fsApi);
        const source = fsApi.lstatSync(paths.ploinky);
        if (source.isSymbolicLink() || !source.isFile()) {
            throw entrypointError(`Ploinky source entrypoint is not a regular file: ${paths.ploinky}`);
        }
        fsApi.accessSync(paths.ploinky, fsApi.constants.R_OK | fsApi.constants.X_OK);
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw entrypointError('Required Box mount is missing or not writable by podman', error);
    }
}

export function resetTransientNestedRuntime(paths, {
    fsApi = fs,
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
} = {}) {
    for (const name of [`storage-run-${uid}`, `podman-run-${uid}`]) {
        const target = path.join(paths.tmp, name);
        fsApi.rmSync(target, { recursive: true, force: true });
    }
}

export function prepareEntrypoint({
    root = '/',
    fsApi = fs,
    runner = createProcessRunner(),
    initialize = initializeWorkspaceMasterKey,
    configureTransport = configureBoxTransport,
    resetRuntime = resetTransientNestedRuntime,
    installDependencies = installPinnedDependencies,
    transportOptions = {},
} = {}) {
    const paths = entrypointPaths(root);
    verifyEntrypointContract(paths.contract, fsApi);
    validateEntrypointMounts(paths, fsApi);
    initialize({ workspaceRoot: paths.workspace, fsApi });
    const transport = configureTransport({
        runner,
        transportFile: paths.transport,
        containersConf: paths.containersConf,
        fsApi,
        ...transportOptions,
    });
    resetRuntime(paths, { fsApi });
    installDependencies({
        targetRoot: paths.dependencies,
        contractPath: paths.contract,
        fsApi,
        runner,
    });
    return Object.freeze({ paths, transport });
}

export function runEntrypoint({
    output = process.stdout,
    selfCheck = () => {},
    ...options
} = {}) {
    const prepared = prepareEntrypoint(options);
    selfCheck(prepared);
    output.write(`${BOX_READY_LINE}\n`);
    return prepared;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const prepareOnly = process.argv.slice(2).includes('--prepare-only');
        if (prepareOnly) prepareEntrypoint();
        else runEntrypoint();
    } catch (error) {
        process.stderr.write(`[ploinky-box] SELF-CHECK FAILED: ${error.message}\n`);
        process.exitCode = 1;
    }
}
