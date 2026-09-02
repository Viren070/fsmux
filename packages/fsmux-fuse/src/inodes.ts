export const ROOT_INO = 1n;

interface Entry {
  path: string;
  nlookup: number;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The inodes the kernel currently knows about. FUSE hands out an inode on
 * every successful lookup and takes it back with `forget`, counted, so a
 * path only needs remembering while the kernel can still ask about its ino.
 * The root is inode 1 and is never forgotten.
 */
export class InodeTable {
  private readonly byIno = new Map<bigint, Entry>();
  private readonly byPath = new Map<string, bigint>();
  /** Parent path -> names of remembered children, for invalidation. */
  private readonly children = new Map<string, Set<string>>();

  constructor() {
    this.byIno.set(ROOT_INO, { path: '/', nlookup: 1 });
    this.byPath.set('/', ROOT_INO);
  }

  get size(): number {
    return this.byIno.size;
  }

  path(ino: bigint): string | undefined {
    return this.byIno.get(ino)?.path;
  }

  ino(path: string): bigint | undefined {
    return this.byPath.get(path);
  }

  /** Names under a directory the kernel may still hold cached. */
  knownChildren(dirPath: string): string[] {
    return [...(this.children.get(dirPath) ?? [])];
  }

  /** A lookup succeeded: the kernel holds one more reference to `ino`. */
  remember(ino: bigint, path: string): void {
    if (ino === ROOT_INO) return;
    const entry = this.byIno.get(ino);
    if (entry) {
      entry.nlookup++;
      if (entry.path !== path) {
        this.unindex(entry.path, ino);
        entry.path = path;
        this.index(path, ino);
      }
      return;
    }
    this.byIno.set(ino, { path, nlookup: 1 });
    this.index(path, ino);
  }

  forget(ino: bigint, nlookup: number): void {
    if (ino === ROOT_INO) return;
    const entry = this.byIno.get(ino);
    if (!entry) return;
    entry.nlookup -= nlookup;
    if (entry.nlookup > 0) return;
    this.byIno.delete(ino);
    this.unindex(entry.path, ino);
  }

  private index(path: string, ino: bigint): void {
    this.byPath.set(path, ino);
    const parent = parentOf(path);
    let names = this.children.get(parent);
    if (!names) this.children.set(parent, (names = new Set()));
    names.add(nameOf(path));
  }

  private unindex(path: string, ino: bigint): void {
    if (this.byPath.get(path) === ino) this.byPath.delete(path);
    const parent = parentOf(path);
    const names = this.children.get(parent);
    if (!names) return;
    names.delete(nameOf(path));
    if (names.size === 0) this.children.delete(parent);
  }
}
