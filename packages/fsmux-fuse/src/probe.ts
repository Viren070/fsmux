import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadNativeBinding } from './binding.js';

export interface FuseProbe {
  ok: boolean;
  /** What is missing, when not ok. */
  reason?: string;
  /** Running as root: mounts go through mount(2) rather than fusermount. */
  root: boolean;
}

export interface ProbeOptions {
  /** The mount will ask for `allow_other`, which non-root needs opting into. */
  allowOther?: boolean;
}

const CAP_SYS_ADMIN = 21n;

/**
 * Whether a mount could work here, before trying. A mount fails at runtime
 * for reasons a config toggle cannot express (no binding, no device, no
 * capability), and each deserves a sentence rather than an errno.
 */
export async function probeFuse(opts: ProbeOptions = {}): Promise<FuseProbe> {
  const root = process.getuid?.() === 0;
  const { reason } = loadNativeBinding();
  if (reason) return { ok: false, reason, root };
  try {
    await access('/dev/fuse', constants.R_OK | constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      root,
      reason:
        code === 'ENOENT'
          ? 'no /dev/fuse: pass the device into the container ' +
            '(`devices: - /dev/fuse:/dev/fuse:rwm`) or load the fuse module'
          : `cannot open /dev/fuse (${code})`,
    };
  }
  if (root) {
    if (!(await hasCapability(CAP_SYS_ADMIN))) {
      return {
        ok: false,
        root,
        reason:
          'no CAP_SYS_ADMIN: add `cap_add: - SYS_ADMIN` to the container ' +
          '(and `security_opt: - apparmor:unconfined` if the mount is still refused)',
      };
    }
    return { ok: true, root };
  }
  if (!(await findOnPath(['fusermount3', 'fusermount']))) {
    return {
      ok: false,
      root,
      reason:
        'not root and no fusermount3 on PATH: install fuse3, or run as root ' +
        'with CAP_SYS_ADMIN',
    };
  }
  if (opts.allowOther && !(await userAllowOther())) {
    return {
      ok: false,
      root,
      reason:
        'allow_other needs `user_allow_other` in /etc/fuse.conf when not ' +
        'running as root',
    };
  }
  return { ok: true, root };
}

async function hasCapability(bit: bigint): Promise<boolean> {
  try {
    const status = await readFile('/proc/self/status', 'utf8');
    const match = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(status);
    if (!match) return true;
    return (BigInt(`0x${match[1]}`) & (1n << bit)) !== 0n;
  } catch {
    // Not a Linux procfs; let the mount attempt decide.
    return true;
  }
}

async function findOnPath(names: string[]): Promise<string | undefined> {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

async function userAllowOther(): Promise<boolean> {
  try {
    const conf = await readFile('/etc/fuse.conf', 'utf8');
    return /^\s*user_allow_other\s*$/m.test(conf);
  } catch {
    return false;
  }
}
