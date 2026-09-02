# fsmux

Point one filesystem at it; serve it over several protocols.

`fsmux` takes a **`SharedFilesystem`** — six methods you implement — and exposes
that same tree over **NFSv4**, **WebDAV**, and (through the companion package) a
local **FUSE** mount. Your implementation never sees a wire concept: no XDR, no
multistatus XML, no inode numbers. Anything you can describe as directories,
files and symlinks can be exported, whether or not it exists on disk.

That last part is the point. The tree can be entirely synthetic — files whose
bytes are fetched on demand, generated, or streamed from somewhere else — and
the protocol servers neither know nor care.

## Packages

| Package | What it is |
| --- | --- |
| [`fsmux`](packages/fsmux) | The contract plus the NFSv4 and WebDAV servers. Pure TypeScript, zero runtime dependencies, runs anywhere. |
| [`fsmux-fuse`](packages/fsmux-fuse) | Mounts the same `SharedFilesystem` as a local directory through FUSE. Linux only; ships prebuilt binaries, so consumers need no Rust toolchain. |

They are separate packages because of the build, not the design — a FUSE mount
is conceptually just one more way to expose the tree, but bundling a Rust crate
into the JS library would make every WebDAV user deal with native binaries.

## Quick start

```ts
import { NfsServer, handleWebdav, type SharedFilesystem } from 'fsmux';

const fs: SharedFilesystem = {
  async resolve(path) {
    /* the node at an absolute path, or undefined */
  },
  async lookup(dir, name) {
    /* one child by name */
  },
  async readdir(dir) {
    /* the children */
  },
  async open(file) {
    /* a handle with read(offset, length) and close() */
  },
  async remove(node) {
    /* 'removed' | 'missing' | 'denied' | 'failed' */
  },
};

// NFSv4 on 2049, read-only, restricted to private networks.
const nfs = new NfsServer({ fs, allowedClients: ['10.0.0.0/8'] });
await nfs.listen();

// WebDAV, mounted under /webdav on any Node http server or Express app.
http.createServer((req, res) => handleWebdav(req, res, { fs, base: '/webdav' }));
```

An optional seventh method, `openStream`, lets a filesystem serve a byte range
as a stream in one call where that is cheaper than repeated handle reads.

## What is implemented

**NFSv4.0** (RFC 7530) read-only: LOOKUP, GETATTR, ACCESS, READ, READDIR,
READLINK, OPEN/CLOSE, REMOVE, plus the client and state machinery
(SETCLIENTID, RENEW, leases, persistable filehandles). Everything that mutates
returns `ROFS`; locking returns `LOCK_NOTSUPP`. AUTH_SYS with a CIDR allowlist,
since NFSv4 carries no authentication of its own. Minor version 4.1+ is
declined with `MINOR_VERS_MISMATCH`, which Linux clients handle by negotiating
down to 4.0.

**WebDAV** read-only: PROPFIND (depth 0 and 1), GET and HEAD with byte ranges
and suffix ranges, OPTIONS, DELETE. Links are served in rclone's `.rclonelink`
convention by default, so `rclone mount --links` materialises them as real
symlinks; `links: 'hide'` drops them instead, for clients that would only be
confused by a stray text file.

**FUSE** (in `fsmux-fuse`): real symlinks, directory invalidation without a
remount, and the kernel's lookup counts driving an inode table.

## Development

Requires Node >= 24 and pnpm >= 11. The Rust toolchain is only needed to build
the FUSE addon, and only on Linux.

```sh
pnpm install
pnpm build          # TypeScript everywhere; the addon only on Linux with cargo
pnpm test           # both packages
pnpm typecheck
```

The FUSE mount tests mount an in-memory tree through the real kernel and assert
through real syscalls; on a host that cannot mount, they skip with the reason
`probeFuse()` reports.

## Licence

MIT.
