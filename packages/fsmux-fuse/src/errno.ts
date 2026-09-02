import { fsErrorCode } from '@viren070/fsmux';

export const ENOENT = 2;
export const EIO = 5;
export const EBADF = 9;
export const EACCES = 13;
export const ENOTDIR = 20;
export const EISDIR = 21;
export const EINVAL = 22;
export const EROFS = 30;
export const ENOSYS = 38;
export const ENOTCONN = 107;

/** A failure the kernel should see as this errno. */
export class FuseErrno extends Error {
  constructor(
    readonly errno: number,
    message = `errno ${errno}`,
  ) {
    super(message);
    this.name = 'FuseErrno';
  }
}

/**
 * The errno for anything thrown while serving a request. `Unavailable` is
 * EIO on purpose: a retry code would have the kernel retry forever while a
 * refused stream hangs the reader.
 */
export function errnoOf(err: unknown): number {
  if (err instanceof FuseErrno) return err.errno;
  switch (fsErrorCode(err)) {
    case 'NotFound':
      return ENOENT;
    case 'NotPermitted':
      return EACCES;
    default:
      return EIO;
  }
}
