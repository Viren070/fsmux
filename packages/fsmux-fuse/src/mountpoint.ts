import { readFile, stat } from 'node:fs/promises';

export interface MountInfo {
  mountPoint: string;
  fsType: string;
  source: string;
}

/** mountinfo escapes space, tab, newline and backslash as octal. */
function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

/** What is mounted at `mountPath` right now (the topmost, if stacked). */
export async function mountInfoAt(
  mountPath: string,
): Promise<MountInfo | undefined> {
  let text: string;
  try {
    text = await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return undefined;
  }
  let found: MountInfo | undefined;
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const head = line.slice(0, sep).split(' ');
    if (head.length < 5 || unescape(head[4]) !== mountPath) continue;
    const tail = line.slice(sep + 3).split(' ');
    found = {
      mountPoint: mountPath,
      fsType: tail[0] ?? '',
      source: unescape(tail[1] ?? ''),
    };
  }
  return found;
}

/** A FUSE mount whose server died answers every call with ENOTCONN. */
export async function isStaleMount(mountPath: string): Promise<boolean> {
  try {
    await stat(mountPath);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOTCONN';
  }
}

export interface ClearOptions {
  fsName: string;
  detach(mountPath: string): Promise<void> | void;
}

/**
 * Make `mountPath` mountable: a dead mount of ours is detached, a live one
 * (another process still serving it) or somebody else's filesystem is left
 * alone and reported.
 */
export async function clearMountpoint(
  mountPath: string,
  opts: ClearOptions,
): Promise<'clear' | 'detached'> {
  const info = await mountInfoAt(mountPath);
  if (!info) return 'clear';
  if (!(await isStaleMount(mountPath))) {
    const ours =
      info.fsType === `fuse.${opts.fsName}` || info.source === opts.fsName;
    throw new Error(
      ours
        ? `${mountPath} is already served by another live process`
        : `${mountPath} is already a mountpoint (${info.fsType} from ${info.source})`,
    );
  }
  await opts.detach(mountPath);
  return 'detached';
}
