// `node --import c5MutationRegister.mjs`: install the load hook of c5MutationLoader.mjs for the mutation named by C5_MUTATION (JSON). Without the
// variable nothing is registered.
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { applyPatches, ROOT } from './c5Mutation.mjs';

const text = process.env.C5_MUTATION;
if (text) {
    const spec = JSON.parse(text);
    if (typeof spec?.file !== 'string' || spec.file.startsWith('/') || spec.file.includes('..') || !Array.isArray(spec.patches) || !spec.patches.length) throw new Error('invalid C5 mutation');
    // Fail here, in the main thread, when a patch does not match exactly once: that is a setup failure, not a kill.
    applyPatches(fs.readFileSync(path.join(ROOT, spec.file), 'utf8'), spec.patches);
    register('./c5MutationLoader.mjs', import.meta.url, { data: { file: path.join(ROOT, spec.file), patches: spec.patches } });
}
