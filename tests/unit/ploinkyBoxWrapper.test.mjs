// Auto-discovery shim: tests/test_all.sh runs every tests/unit/*.test.mjs with
// `node --test`; importing wrapper-tests.mjs registers the ploinky-box wrapper
// tests (engine-free - they use the wrapper's --dry-run seam).
import '../../container/wrapper-tests.mjs';
