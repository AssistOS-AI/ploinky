// Module customization hooks (run in the loader thread): patch the source of one file as it loads.
import { pathToFileURL } from 'node:url';
import { applyPatches } from './c5Mutation.mjs';

let target = null;
let patches = [];

export async function initialize(data) {
    target = pathToFileURL(data.file).href;
    patches = data.patches;
}

export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (url !== target) return result;
    const source = Buffer.from(result.source).toString('utf8');
    return { ...result, source: applyPatches(source, patches), shortCircuit: true };
}
