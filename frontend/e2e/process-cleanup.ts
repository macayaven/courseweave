import { spawnSync, type ChildProcess } from 'node:child_process';

export type OwnedProcess = {
  pid: number;
  parentPid: number;
  processGroup: number;
  startedAt: string;
};

function processTable(): OwnedProcess[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error('Could not inspect the owned CourseWeave process tree.');
  }
  return result.stdout.split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const numbers = fields.slice(0, 3).map(Number);
    return fields.length === 8 && numbers.every(Number.isSafeInteger)
      ? [{
          pid: numbers[0]!,
          parentPid: numbers[1]!,
          processGroup: numbers[2]!,
          startedAt: fields.slice(3).join(' ')
        }]
      : [];
  });
}

function sameProcess(left: OwnedProcess, right: OwnedProcess): boolean {
  // A PID can be reused during a bounded wait. The start timestamp keeps a new
  // process from being reported as part of this fixture's owned process tree.
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

export class OwnedProcessTracker {
  private readonly tracked = new Map<number, OwnedProcess>();

  constructor(private readonly rootPid: number) {
    this.refresh();
  }

  refresh(): OwnedProcess[] {
    const rows = processTable();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const selected = new Set<number>();
    const knownRoot = this.tracked.get(this.rootPid);
    const currentRoot = byPid.get(this.rootPid);
    if (currentRoot !== undefined && (knownRoot === undefined || sameProcess(currentRoot, knownRoot))) {
      selected.add(this.rootPid);
    }
    for (const known of this.tracked.values()) {
      const current = byPid.get(known.pid);
      if (current !== undefined && sameProcess(current, known)) selected.add(known.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!selected.has(row.pid) && selected.has(row.parentPid)) {
          selected.add(row.pid);
          changed = true;
        }
      }
    }
    for (const pid of selected) {
      const row = byPid.get(pid);
      if (row !== undefined) this.tracked.set(pid, row);
    }
    return [...this.tracked.values()].filter((known) => {
      const current = byPid.get(known.pid);
      return current !== undefined && sameProcess(current, known);
    });
  }

  snapshot(): OwnedProcess[] {
    return [...this.tracked.values()];
  }

  live(): OwnedProcess[] {
    const byPid = new Map(processTable().map((row) => [row.pid, row]));
    return this.snapshot().filter((known) => {
      const current = byPid.get(known.pid);
      return current !== undefined && sameProcess(current, known);
    });
  }
}

async function waitForOwnedExit(tracker: OwnedProcessTracker, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tracker.refresh().length === 0) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return tracker.refresh().length === 0;
}

export async function stopOwnedProcess(
  child: ChildProcess,
  existingTracker?: OwnedProcessTracker,
  options: { failOnForcedTermination?: boolean } = {}
): Promise<OwnedProcess[]> {
  if (child.pid === undefined) return [];
  const tracker = existingTracker ?? new OwnedProcessTracker(child.pid);
  tracker.refresh();
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('CourseWeave supervisor exited before its owned descendants.');
  }
  // Signal only through Node's handle for the unreaped direct child. Descendant
  // PIDs are observed, never signalled; production cleanup must reap them.
  if (!child.kill('SIGTERM') && tracker.refresh().length > 0) {
    throw new Error('CourseWeave supervisor could not be signalled through its owned handle.');
  }
  if (!(await waitForOwnedExit(tracker, 10_000))) {
    child.kill('SIGKILL');
    if (!(await waitForOwnedExit(tracker, 5_000))) {
      throw new Error('Owned CourseWeave process tree survived bounded cleanup.');
    }
    if (options.failOnForcedTermination) {
      throw new Error('CourseWeave supervisor required forced termination.');
    }
  }
  return tracker.snapshot();
}
