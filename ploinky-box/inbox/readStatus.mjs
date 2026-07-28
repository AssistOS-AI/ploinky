#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProcessRunner } from '../process.mjs';
import { serializeCloudflarePublicationStatus } from '../cloudflared/status.mjs';

const LOCAL_CLOUDFLARE_STATUS = serializeCloudflarePublicationStatus({
    mode: 'local-only',
    management: null,
    state: 'unstarted',
    connectorState: 'absent',
});

function readRegular(target, fsApi) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
    return fsApi.readFileSync(target, 'utf8');
}

function readJson(target, fsApi, warnings) {
    try {
        const value = JSON.parse(readRegular(target, fsApi));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        return value;
    } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`${path.basename(target)} is unreadable`);
        return null;
    }
}

function readCloudflarePublicationStatus(ploinkyRoot, fsApi, warnings) {
    const runRoot = path.join(ploinkyRoot, 'run');
    const statusPath = path.join(runRoot, 'cloudflare-publication-status.json');
    try {
        const runStats = fsApi.lstatSync(runRoot);
        if (!runStats.isDirectory() || runStats.isSymbolicLink()) {
            throw new Error('run is not a real directory');
        }
        const value = JSON.parse(readRegular(statusPath, fsApi));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        return serializeCloudflarePublicationStatus(value);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            warnings.push('cloudflare-publication-status.json is unreadable');
        }
        return LOCAL_CLOUDFLARE_STATUS;
    }
}

export function readInboxStatus({
    workspaceRoot = '/workspace',
    fsApi = fs,
    runner = createProcessRunner(),
} = {}) {
    const root = path.resolve(workspaceRoot);
    const ploinkyRoot = path.join(root, '.ploinky');
    const warnings = [];
    let marker;
    try { marker = fsApi.lstatSync(ploinkyRoot); } catch (error) {
        if (error.code === 'ENOENT') {
            return Object.freeze({
                state: 'not-initialized',
                initialized: false,
                routingConfigured: false,
                trackedAgents: 0,
                runningAgents: 0,
                cloudflarePublication: LOCAL_CLOUDFLARE_STATUS,
                warnings: Object.freeze([]),
            });
        }
        throw error;
    }
    if (marker.isSymbolicLink() || !marker.isDirectory()) {
        return Object.freeze({
            state: 'invalid-initialization', initialized: false,
            routingConfigured: false, trackedAgents: 0, runningAgents: 0,
            cloudflarePublication: LOCAL_CLOUDFLARE_STATUS,
            warnings: Object.freeze(['.ploinky is not a real directory']),
        });
    }
    const routing = readJson(path.join(ploinkyRoot, 'routing.json'), fsApi, warnings);
    const agents = readJson(path.join(ploinkyRoot, 'agents.json'), fsApi, warnings) || {};
    const cloudflarePublication = readCloudflarePublicationStatus(ploinkyRoot, fsApi, warnings);
    const tracked = Object.entries(agents).filter(([, record]) => (
        record && ['agent', 'agentCore'].includes(record.type)
    ));
    let runningAgents = 0;
    for (const [recordedName, record] of tracked) {
        const containerId = String(record.containerId || '').trim().toLowerCase();
        if (record.runtime !== 'podman' || !/^[a-f0-9]{64}$/.test(containerId)) {
            warnings.push(`${recordedName} lacks a complete nested-Podman identity`);
            continue;
        }
        const inspected = runner.query('podman', ['container', 'inspect', containerId]);
        if (!inspected.ok) {
            warnings.push(`${recordedName} disappeared during status inspection`);
            continue;
        }
        try {
            const values = JSON.parse(inspected.stdout);
            const value = Array.isArray(values) && values.length === 1 ? values[0] : null;
            const id = String(value?.Id ?? value?.ID ?? '').toLowerCase();
            const name = String(value?.Name ?? '').replace(/^\//, '');
            if (id !== containerId || name !== recordedName) {
                warnings.push(`${recordedName} changed identity during status inspection`);
            } else if (value?.State?.Running === true || value?.State?.Status === 'running') {
                runningAgents += 1;
            }
        } catch {
            warnings.push(`${recordedName} returned malformed status`);
        }
    }
    return Object.freeze({
        state: 'initialized',
        initialized: true,
        routingConfigured: Boolean(routing),
        trackedAgents: tracked.length,
        runningAgents,
        cloudflarePublication,
        warnings: Object.freeze(warnings),
    });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    process.stdout.write(`${JSON.stringify(readInboxStatus())}\n`);
}
