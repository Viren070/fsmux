# fsmux-fuse

Mounts an [`fsmux`](https://www.npmjs.com/package/fsmux) `SharedFilesystem` as a
local directory through FUSE. Linux only.

The kernel side is [fuser](https://github.com/cberner/fuser) built without
libfuse, wrapped with [napi-rs](https://napi.rs). Every request reaches
JavaScript over a threadsafe function and is answered from your tree, so all
filesystem logic stays in TypeScript and the native layer is a thin relay.

Prebuilt binaries for `linux-x64-gnu` and `linux-arm64-gnu` ship in the package,
so installing it needs no Rust toolchain.

```sh
pnpm add fsmux-fuse   # npm install / yarn add work too
```

```ts
import { mountSharedFilesystem, probeFuse } from 'fsmux-fuse';

const probe = await probeFuse({ allowOther: true });
if (!probe.ok) throw new Error(probe.reason);

const mount = await mountSharedFilesystem({
  mountPath: '/mnt/library',
  fs: sharedFilesystem,
  allowOther: true,
});

mount.invalidateDir('/completed'); // after the tree changed
await mount.unmount();
```

Unlike a network protocol, a local mount serves **real symlinks** and can push
invalidations to the kernel, so a directory that changes is visible immediately
rather than when a client's cache expires.

## Requirements at runtime

`/dev/fuse`, and then either:

- **as root** — `CAP_SYS_ADMIN`, using the direct `mount(2)` path, which is what
  a container wants; or
- **as a normal user** — `fusermount3` on `PATH`, plus `user_allow_other` in
  `/etc/fuse.conf` if you ask for `allowOther`.

`probeFuse()` reports which of these is missing, in words you can show a user.
Nothing throws just because a host cannot mount: `loadNativeBinding()` returns a
reason instead, so an application can degrade rather than fail to start.

Glibc only. On musl (Alpine) the binding reports itself unavailable; build from
source there.

## Layout

- `crate/` — the Rust addon (`cargo`, `napi build`). Output lands in `native/`
  as `fsmux-fuse.<platform>.node`, with binding types in `src/native.d.ts`.
- `src/` — request dispatch (`mount.ts`), the inode table the kernel's lookup
  counts drive (`inodes.ts`), errno mapping, host probing, and
  stale-mountpoint hygiene.

## Building from source

```sh
pnpm -F fsmux-fuse build
```

Compiles the TypeScript everywhere, and the addon only on Linux with cargo
installed; anywhere else it warns and the package reports the binding as
unavailable with a reason. Set `FUSE_NATIVE_REQUIRED=1` to make a failed native
build fatal — CI does this.

## Tests

`pnpm -F fsmux-fuse test` mounts an in-memory tree through the real kernel and
asserts through real syscalls. On a host that cannot mount, the suite skips with
the probe's reason.

## Licence

MIT.
