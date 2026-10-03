// Test-only module hooks (not a test file) that let the production bwrap
// service manager run on a host without Bubblewrap. Registered with
// `node --import` in the wiring driver's child process only.
//
// bwrapServiceManager.js spawns the absolute BWRAP_PATH (/usr/bin/bwrap),
// which PATH cannot redirect, and proves launch success from
// /proc/<pid>/status, which macOS lacks. Only for imports whose parent is
// that exact module, `child_process` resolves to a shim whose `spawn` runs
// $FAKE_BWRAP instead of /usr/bin/bwrap, and `fs` resolves to a shim whose
// readFileSync answers /proc/<pid>/status from real process liveness.
// Every other module (and every other call) uses the real implementations.

import { register } from 'node:module';

register(new URL('./dependencyStoreBwrapHostHooks.mjs', import.meta.url));
