function aggregateProcessTreeMetrics(stdout, rootPids) {
  const processes = new Map();
  const children = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const [pid, parentPid, cpu, rss] = line.trim().split(/\s+/);
    const numericPid = Number(pid);
    const numericParentPid = Number(parentPid);
    if (!Number.isInteger(numericPid) || numericPid <= 0 || !Number.isInteger(numericParentPid)) continue;
    processes.set(numericPid, {
      cpuPercent: Number(cpu) || 0,
      memoryBytes: (Number(rss) || 0) * 1024,
    });
    if (!children.has(numericParentPid)) children.set(numericParentPid, []);
    children.get(numericParentPid).push(numericPid);
  }

  const byPid = new Map();
  for (const rootPidValue of new Set(rootPids || [])) {
    const rootPid = Number(rootPidValue);
    if (!processes.has(rootPid)) continue;
    const pending = [rootPid];
    const visited = new Set();
    let cpuPercent = 0;
    let memoryBytes = 0;
    while (pending.length) {
      const pid = pending.pop();
      if (visited.has(pid)) continue;
      visited.add(pid);
      const metrics = processes.get(pid);
      if (metrics) {
        cpuPercent += metrics.cpuPercent;
        memoryBytes += metrics.memoryBytes;
      }
      pending.push(...(children.get(pid) || []));
    }
    byPid.set(rootPid, { available: true, cpuPercent, memoryBytes });
  }
  return byPid;
}

export { aggregateProcessTreeMetrics };
