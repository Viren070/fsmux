# @viren070/fsmux

Serve one filesystem over NFSv4 and WebDAV. Implement six methods, get two
protocols.

Pure TypeScript, no runtime dependencies. The tree you describe never has to
exist on disk — files whose bytes are fetched on demand or generated work
exactly the same, because the protocol servers only ever call your methods.

```sh
pnpm add @viren070/fsmux   # npm install / yarn add work too
```

## The contract

```ts
interface SharedFilesystem {
  resolve(path: string): Promise<FsNode | undefined>;
  lookup(dir: FsNode, name: string): Promise<FsNode | undefined>;
  readdir(dir: FsNode): Promise<FsNode[]>;
  open(file: FsNode, opts?: FsOpenOptions): Promise<FsFileHandle>;
  remove(node: FsNode): Promise<FsRemoveOutcome>;
  /** Optional: one byte range as a stream, where that beats handle reads. */
  openStream?(
    file: FsNode,
    range: FsByteRange | undefined,
    signal: AbortSignal,
    opts?: FsOpenOptions
  ): Promise<FsOpenedStream>;
}
```

An `FsNode` is a `dir`, `file` or `link` with a path, a stable 64-bit `id`, a
`mode`, a size and an mtime. Throw an `FsError` with one of `NotFound`,
`NotPermitted`, `Unavailable` or `IoError`, and each server maps it to its own
status — you never write a protocol status yourself.

A note on `mode`: report `0644` on files even in an export nothing can write
to. Plenty of clients clear the read-only attribute before copying or moving a
file, and `0444` makes them attempt a chmod that a read-only export has to
refuse — which they report as a failed copy rather than a permissions detail.
Permissions are not what protects the export; refusing the write is.

## NFSv4

```ts
import { NfsServer } from '@viren070/fsmux';

const nfs = new NfsServer({
  fs,
  port: 2049,
  // NFSv4 with AUTH_SYS has no authentication, so this list is the whole of
  // your access control. Empty allows everyone.
  allowedClients: ['10.0.0.0/8', '192.168.0.0/16'],
  logger, // any object with debug/info/warn/error(obj, msg)
});
await nfs.listen();
```

Clients mount it with `mount -t nfs4 <host>:/ /mnt/point`. No portmapper and no
separate mount protocol: NFSv4 is one TCP port.

Read-only by construction — WRITE, CREATE, SETATTR, LINK, RENAME and COMMIT all
return `ROFS`, and locking returns `LOCK_NOTSUPP`. REMOVE is wired through to
`fs.remove`, so a client can unlink where your filesystem allows it.

Filehandles can be persisted (`handleStore`) so client mounts survive a server
restart; `JsonFileHandleStore` writes them to a file, and the default keeps
them in memory.

## WebDAV

```ts
import { handleWebdav } from '@viren070/fsmux';

// A bare http server, an Express route, anything with (req, res).
app.use('/webdav', (req, res) => handleWebdav(req, res, { fs, base: '/webdav' }));
```

PROPFIND at depth 0 and 1, GET and HEAD with byte and suffix ranges, OPTIONS,
DELETE.

Authentication is yours to add — mount the handler behind whatever middleware
you already use.

### Links

WebDAV has no symbolic link, so a `link` node has to be represented somehow.
The `links` option decides which:

- `'rclonelink'` (default) — a text file holding the target, named with an
  `.rclonelink` suffix. That is rclone's convention, and `rclone mount --links`
  turns it back into a real symlink. Choose this when something will mount the
  share.
- `'hide'` — links are omitted from listings and 404 on both spellings. Choose
  this when the client is a player or a browser, where a stray text file next
  to the media is just confusing.

There is deliberately no `'follow'`: a link's target is a path as the *client*
should see it, which is not necessarily a path inside the export, so the server
cannot resolve it in general.

## Testing your implementation

```ts
import { MemoryFs, dir, file } from '@viren070/fsmux/testing';

const fs = new MemoryFs({
  movies: dir({ 'a.mkv': file('...') }),
});
```

`MemoryFs` is the same fixture this library's own tests run against, so it is a
faithful stand-in for a real implementation.

## Local mounts

[`@viren070/fsmux-fuse`](https://github.com/Viren070/fsmux/tree/main/packages/fsmux-fuse)
mounts the same `SharedFilesystem` as a directory on the host, with real
symlinks and no protocol in between. Linux only.

## Licence

MIT.
