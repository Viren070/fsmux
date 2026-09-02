// Builds the Rust addon with napi-rs. Only Linux can host a FUSE mount and a
// dev machine without cargo must still complete `pnpm build`, so anything
// short of a successful build is a warning; the package then reports the
// binding as unavailable at runtime with the reason.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The binding's type declarations are hand-checked into src/ (napi regenerates
// them on a Linux build) and are not emitted by tsc, so ship a copy.
mkdirSync(path.join(here, 'dist'), { recursive: true });
copyFileSync(
  path.join(here, 'src', 'native.d.ts'),
  path.join(here, 'dist', 'native.d.ts')
);

function skip(reason) {
  console.warn(
    `[fuse] ${reason}; the FUSE mount will report itself unavailable`
  );
  process.exit(process.env.FUSE_NATIVE_REQUIRED ? 1 : 0);
}

if (process.platform !== 'linux') {
  skip(
    `skipping native build on ${process.platform} (FUSE mounts are Linux only)`
  );
}
if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  skip('cargo not found, skipping native build');
}

const napi = path.join(here, 'node_modules', '.bin', 'napi');
if (!existsSync(napi)) skip('@napi-rs/cli is not installed');

const result = spawnSync(
  napi,
  [
    'build',
    '--release',
    '--platform',
    '--manifest-path',
    'crate/Cargo.toml',
    '--output-dir',
    'native',
    '--no-js',
    '--dts',
    '../src/native.d.ts',
    ...process.argv.slice(2),
  ],
  { cwd: here, stdio: 'inherit' }
);
if (result.status !== 0) skip(`native build failed (exit ${result.status})`);
copyFileSync(
  path.join(here, 'src', 'native.d.ts'),
  path.join(here, 'dist', 'native.d.ts')
);
