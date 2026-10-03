// The argv the live runner hands to the candidate's own CLI (`ploinky-box/bin/ploinky-box.mjs`) must be accepted by the candidate's own
// outer parser. LIVE-P3 attempt 7 failed because `--port` and `--udp-port` were put before `restart`, which the parser allows only before
// start, diagnose or repair. This module is the one place the fakes and the tests use to ask the real parser. Test-only.
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';

export const isCandidateArgv = argv => Array.isArray(argv) && typeof argv[0] === 'string' && /(?:^|\/)ploinky-box\/bin\/ploinky-box\.mjs$/.test(argv[0]);

// The parser's refusal for this candidate command line (without the candidate path), or null when it is accepted.
export function candidateArgvProblem(argv) {
    if (!isCandidateArgv(argv)) return null;
    try { parseOuterArguments(argv.slice(1)); return null; } catch (error) { return String(error?.message || error); }
}

// Every operation of a concrete manifest's plan that runs the candidate CLI.
export function candidateOperationsOf(run) {
    return Object.values(run?.target?.plan ?? {}).flat().filter(operation => operation && isCandidateArgv(operation.argv));
}
