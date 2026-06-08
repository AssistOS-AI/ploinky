import process from "node:process";

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const payload = JSON.parse(await readStdin());
if (payload.tool !== "docs_search") fail("Unexpected tool name");

const input = payload.input ?? {};
if (typeof input.query !== "string" || input.query.trim() === "") {
  fail("query is required");
}

const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 20) : 10;
const caller = payload.metadata?.caller ?? payload.metadata?.user ?? "unknown";

// Replace this with the agent's real search implementation.
const results = [
  {
    title: "Example result",
    snippet: `Matched ${JSON.stringify(input.query)}`,
    caller
  }
].slice(0, limit);

process.stdout.write(JSON.stringify({ ok: true, results }, null, 2));
