import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as native from './native.js';

export type NativeBinding = typeof native;

export interface BindingResult {
  binding?: NativeBinding;
  /** Why there is no binding, in words the status panel can show. */
  reason?: string;
}

const require = createRequire(import.meta.url);
let cached: BindingResult | undefined;

/** The platform suffix napi-rs gives the binary, or why there is none. */
export function nativeTarget(): { target?: string; reason?: string } {
  if (process.platform !== 'linux') {
    return { reason: `FUSE mounts need Linux; this is ${process.platform}` };
  }
  const arch =
    process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) return { reason: `no FUSE binding for linux-${process.arch}` };
  return { target: `linux-${arch}-${isMusl() ? 'musl' : 'gnu'}` };
}

function isMusl(): boolean {
  try {
    const report = process.report?.getReport() as
      { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

export function nativeBindingPath(target: string): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'native',
    `fsmux-fuse.${target}.node`,
  );
}

/** Load the addon once; a missing or broken binary is a reason, not a throw. */
export function loadNativeBinding(): BindingResult {
  if (cached) return cached;
  const { target, reason } = nativeTarget();
  if (!target) return (cached = { reason });
  const file = nativeBindingPath(target);
  if (!existsSync(file)) {
    return (cached = {
      reason:
        `native binding not built for ${target}: run \`pnpm -F fuse build\` ` +
        'on Linux with cargo installed',
    });
  }
  try {
    return (cached = { binding: require(file) as NativeBinding });
  } catch (err) {
    return (cached = {
      reason: `could not load ${path.basename(file)}: ${(err as Error).message}`,
    });
  }
}
