// Builds the Rust addon. Only Linux can host a FUSE mount and a dev machine
// without cargo must still complete `pnpm build`, so anything short of a
// successful build is a warning; the package then reports the binding as
// unavailable at runtime with the reason.
//
// Two paths, because a prebuild's glibc floor decides which machines can load
// it and nothing infers that floor correctly:
//
//   --glibc <version>  build the gnu target with `cargo zigbuild --target
//                      <triple>.<version>`, which is the only way to state the
//                      floor outright. `napi build` rejects a versioned triple,
//                      and cargo-zigbuild left to itself picks a baseline for a
//                      cross target but the host's glibc for the native one --
//                      which is how 0.2.0 through 0.2.2 shipped an x64 binary
//                      that could not load on Debian 12.
//   otherwise          `napi build`, which is right for musl (no glibc to pin)
//                      and for local development.
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

const argv = process.argv.slice(2);

/** Pull `--name value` out of the args, leaving the rest for the builder. */
function takeOption(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const [value] = argv.splice(i, 2).slice(1);
  if (!value) skip(`--${name} needs a value`);
  return value;
}

const glibc = takeOption('glibc');
const target = takeOption('target');

/** The suffix napi gives the binary, which `nativeTarget()` looks for. */
function platformName(triple) {
  const [arch, , , abi] = triple.split('-');
  const cpu = { x86_64: 'x64', aarch64: 'arm64' }[arch];
  if (!cpu || !abi) skip(`cannot name a binary for the target ${triple}`);
  return `linux-${cpu}-${abi.startsWith('musl') ? 'musl' : 'gnu'}`;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: here, stdio: 'inherit' });
  if (res.status !== 0) {
    skip(`native build failed (${cmd} exited ${res.status ?? 'on a signal'})`);
  }
}

if (glibc) {
  if (!target) skip('--glibc needs --target');
  // `cargo zigbuild --version` is not a valid invocation; ask the binary.
  if (spawnSync('cargo-zigbuild', ['--version'], { stdio: 'ignore' }).status !== 0) {
    skip('cargo-zigbuild is not installed (cargo install cargo-zigbuild)');
  }
  run('cargo', [
    'zigbuild',
    '--release',
    '--manifest-path',
    'crate/Cargo.toml',
    '--target',
    `${target}.${glibc}`,
    ...argv,
  ]);
  // zigbuild strips the version back off for the artifact directory.
  const built = path.join(
    here,
    'crate/target',
    target,
    'release/libfsmux_fuse.so'
  );
  if (!existsSync(built)) skip(`no artifact at ${built}`);
  mkdirSync(path.join(here, 'native'), { recursive: true });
  copyFileSync(
    built,
    path.join(here, 'native', `fsmux-fuse.${platformName(target)}.node`)
  );
} else {
  const napi = path.join(here, 'node_modules', '.bin', 'napi');
  if (!existsSync(napi)) skip('@napi-rs/cli is not installed');
  run(napi, [
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
    ...(target ? ['--target', target] : []),
    ...argv,
  ]);
}

copyFileSync(
  path.join(here, 'src', 'native.d.ts'),
  path.join(here, 'dist', 'native.d.ts')
);
