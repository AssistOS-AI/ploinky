// Auto-discovery shim: tests/test_all.sh runs every tests/unit/*.test.mjs with
// `node --test`; importing runtime-supervisor-tests.mjs registers the host
// supervisor tests (engine-free through the supervisor's --dry-run seam).
import '../../container/runtime-supervisor-tests.mjs';
