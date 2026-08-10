import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PloinkyBoxError } from '../errors.mjs';

export const AGENTLIB_RELATIVE_CHECKOUT = 'node_modules/achillesAgentLib';
export const AGENTLIB_PACKAGE_NAME = 'ploinky-agent-lib';

function checkoutError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_AGENTLIB_CHECKOUT_INVALID',
        cause,
    });
}

function runGit(args, { cwd, env = process.env, spawn = spawnSync } = {}) {
    const result = spawn('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        shell: false,
    });
    if (result.error || result.status !== 0) {
        throw checkoutError(
            `Git command failed: git ${args.join(' ')} (${String(result.stderr || result.error?.message || '').trim()})`,
            result.error,
        );
    }
    return String(result.stdout || '').trim();
}

function packageEntryPoint(pkg) {
    const rootExport = pkg?.exports?.['.'];
    const exported = typeof pkg?.exports === 'string'
        ? pkg.exports
        : typeof rootExport === 'string'
            ? rootExport
            : rootExport?.import || rootExport?.default || rootExport?.require;
    return String(pkg?.main || exported || '').replace(/^\.\//, '');
}

export function validateAgentlibPackage(checkoutPath, { fsApi = fs } = {}) {
    const selected = path.resolve(checkoutPath);
    const packagePath = path.join(selected, 'package.json');
    let packageStat;
    let pkg;
    try {
        packageStat = fsApi.lstatSync(packagePath);
        pkg = JSON.parse(fsApi.readFileSync(packagePath, 'utf8'));
    } catch (error) {
        throw checkoutError(`Unable to read AchillesAgentLib package.json at ${packagePath}`, error);
    }
    if (packageStat.isSymbolicLink() || !packageStat.isFile()) {
        throw checkoutError(`AchillesAgentLib package.json is not a regular file: ${packagePath}`);
    }
    if (pkg.name !== AGENTLIB_PACKAGE_NAME) {
        throw checkoutError(`AchillesAgentLib must declare package name ${AGENTLIB_PACKAGE_NAME}`);
    }
    const entryPoint = packageEntryPoint(pkg);
    if (!entryPoint) throw checkoutError('AchillesAgentLib package.json must declare a main export');
    const entryPath = path.resolve(selected, entryPoint);
    if (!entryPath.startsWith(`${selected}${path.sep}`)) {
        throw checkoutError('AchillesAgentLib main export escapes the checkout');
    }
    let entryStat;
    try {
        entryStat = fsApi.lstatSync(entryPath);
    } catch (error) {
        throw checkoutError(`AchillesAgentLib main export is missing: ${entryPoint}`, error);
    }
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
        throw checkoutError(`AchillesAgentLib main export is not a regular file: ${entryPoint}`);
    }
    return Object.freeze({ packagePath, entryPoint, package: pkg });
}

export function validateAgentlibCheckout(checkoutPath, {
    fsApi = fs,
    spawn = spawnSync,
    env = process.env,
} = {}) {
    const selected = path.resolve(checkoutPath);
    let stat;
    try {
        stat = fsApi.lstatSync(selected);
    } catch (error) {
        throw checkoutError(`AchillesAgentLib checkout is missing: ${selected}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw checkoutError(`AchillesAgentLib checkout is not a real directory: ${selected}`);
    }
    let top;
    try {
        top = fsApi.realpathSync(runGit(
            ['-C', selected, 'rev-parse', '--show-toplevel'],
            { cwd: selected, env, spawn },
        ));
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw checkoutError(`Unable to resolve AchillesAgentLib Git top-level: ${selected}`, error);
    }
    const realSelected = fsApi.realpathSync(selected);
    if (top !== realSelected) {
        throw checkoutError(`AchillesAgentLib Git top-level does not match ${selected}`);
    }
    const validated = validateAgentlibPackage(selected, { fsApi });
    return Object.freeze({ checkoutPath: selected, ...validated });
}

export function ensureAgentlibCheckout({
    repositoryRoot,
    fsApi = fs,
    spawn = spawnSync,
    env = process.env,
} = {}) {
    const root = path.resolve(repositoryRoot);
    let rootStat;
    try {
        rootStat = fsApi.lstatSync(root);
    } catch (error) {
        throw checkoutError(`Ploinky repository root is missing: ${root}`, error);
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw checkoutError(`Ploinky repository root is not a real directory: ${root}`);
    }
    const checkoutPath = path.join(root, AGENTLIB_RELATIVE_CHECKOUT);
    let initialize = false;
    let checkoutStat;
    try {
        checkoutStat = fsApi.lstatSync(checkoutPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw checkoutError('Unable to inspect AchillesAgentLib checkout', error);
        initialize = true;
    }
    if (checkoutStat?.isDirectory() && !checkoutStat.isSymbolicLink()) {
        try {
            initialize = fsApi.readdirSync(checkoutPath).length === 0;
        } catch (error) {
            throw checkoutError('Unable to inspect AchillesAgentLib checkout contents', error);
        }
    }
    if (initialize) {
        runGit(
            ['submodule', 'update', '--init', '--', AGENTLIB_RELATIVE_CHECKOUT],
            { cwd: root, env, spawn },
        );
    }
    return validateAgentlibCheckout(checkoutPath, { fsApi, spawn, env });
}
