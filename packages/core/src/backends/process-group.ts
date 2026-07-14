/**
 * Process-group kill helpers shared byte-for-byte between backends/codex.ts
 * and backends/grok.ts. Both spawn their child detached (own process group)
 * so a SIGTERM/SIGKILL escalation must target the group (-pid) as well as the
 * pid itself to reach any grandchildren.
 */

export function signalTree(pid: number, signal: NodeJS.Signals): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        // Best effort; finalization still has a force timer.
      }
    }
  }
}

export function killProcessGroup(pid: number): Promise<void> {
  return new Promise((resolve) => {
    signalTree(pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      signalTree(pid, "SIGKILL");
      resolve();
    }, 5_000);
    killTimer.unref?.();
  });
}
