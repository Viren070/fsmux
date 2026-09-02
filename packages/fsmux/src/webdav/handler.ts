import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  fsErrorCode,
  resolveRange,
  type FsByteRange,
  type FsErrorCode,
  type FsNode,
  type FsOpenedStream,
  type SharedFilesystem,
} from '../fs.js';
import { silentLogger, type Logger } from '../logger.js';

/**
 * Read-only WebDAV (class 1) over a {@link SharedFilesystem}, on plain Node
 * HTTP objects so any framework can mount it. Authentication is the caller's:
 * this handler assumes the request may see the whole filesystem it is given.
 */
export const RCLONE_LINK_SUFFIX = '.rclonelink';

/**
 * What to do with a link node, since WebDAV has no symbolic link of its own.
 *
 * `rclonelink` serves it as a text file holding the target, named with an
 * `.rclonelink` suffix — rclone's convention, which `rclone mount --links`
 * turns back into a real symlink. `hide` omits links from listings and 404s
 * them, which is what you want when the client is a player or a browser and a
 * stray text file would only confuse it.
 *
 * There is deliberately no `follow`: a link's target is a path as the *client*
 * should see it, which is not necessarily a path inside this export, so the
 * server cannot resolve it in general.
 */
export type DavLinkPolicy = 'rclonelink' | 'hide';

const ALLOW = 'OPTIONS, GET, HEAD, PROPFIND, DELETE';
const METHODS = new Set(['PROPFIND', 'GET', 'HEAD', 'DELETE']);
/** Handle reads per chunk when the filesystem has no stream of its own. */
const HANDLE_CHUNK = 256 * 1024;

export interface WebdavOptions {
  fs: SharedFilesystem;
  /** URL path the share is mounted at (`/webdav`); hrefs are built on it. */
  base: string;
  /**
   * Request path below `base`. Defaults to the URL path with `base` removed
   * when present, which suits both a bare `http` server and a mounted
   * router whose `req.url` is already relative.
   */
  path?: string;
  /** Address of the client, passed to the filesystem for attribution. */
  peer?: string;
  /** How link nodes are represented; defaults to `rclonelink`. */
  links?: DavLinkPolicy;
  logger?: Logger;
}

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
};

export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);
}

/** Percent-encode a DAV path one segment at a time, keeping the slashes. */
export function encodeDavPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Split and percent-decode a request path. Undefined for a path that is
 * malformed or tries to escape upward.
 */
export function parseDavPath(path: string): string[] | undefined {
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\0')
    ) {
      return undefined;
    }
    segments.push(segment);
  }
  return segments;
}

/** A link node as this protocol presents it: name, bytes and validator. */
export interface DavLinkView {
  name: string;
  path: string;
  text: string;
  size: number;
  etag: string;
  contentType: string;
}

export function davLinkView(node: FsNode): DavLinkView {
  const target = node.target ?? '';
  const digest = createHash('sha1').update(target).digest('hex').slice(0, 20);
  return {
    name: `${node.name}${RCLONE_LINK_SUFFIX}`,
    path: `${node.path}${RCLONE_LINK_SUFFIX}`,
    text: target,
    size: Buffer.byteLength(target),
    etag: `"l-${digest}"`,
    contentType: 'text/plain',
  };
}

/**
 * Resolve a request path. A trailing `.rclonelink` is this protocol's
 * spelling of a link, so it is stripped before the filesystem is consulted
 * and the node is only returned if it really is one; the bare name of a
 * link does not exist over WebDAV, and a file must not answer to the suffix.
 */
export async function resolveDavPath(
  fs: SharedFilesystem,
  path: string,
  links: DavLinkPolicy = 'rclonelink',
): Promise<FsNode | undefined> {
  const segments = parseDavPath(path);
  if (!segments) return undefined;
  const last = segments[segments.length - 1];
  const isLinkRequest =
    links === 'rclonelink' && !!last && last.endsWith(RCLONE_LINK_SUFFIX);
  if (isLinkRequest) {
    segments[segments.length - 1] = last.slice(0, -RCLONE_LINK_SUFFIX.length);
  }
  const node = await fs.resolve(
    segments.length ? `/${segments.join('/')}` : '/',
  );
  if (!node) return undefined;
  if (node.kind === 'link')
    return links === 'rclonelink' && isLinkRequest ? node : undefined;
  return isLinkRequest ? undefined : node;
}

function etagFor(node: FsNode): string {
  return (
    node.etag ??
    `"${node.id.toString(16)}-${node.size.toString(16)}-${node.modified.getTime().toString(16)}"`
  );
}

function hrefFor(base: string, node: FsNode): string {
  const path = node.kind === 'link' ? davLinkView(node).path : node.path;
  const href = base.replace(/\/$/, '') + encodeDavPath(path);
  if (node.kind !== 'dir') return href;
  return href.endsWith('/') ? href : `${href}/`;
}

function propsFor(node: FsNode): string {
  const name = node.kind === 'link' ? davLinkView(node).name : node.name;
  const shared =
    `<D:displayname>${escapeXml(name)}</D:displayname>` +
    `<D:getlastmodified>${node.modified.toUTCString()}</D:getlastmodified>`;
  if (node.kind === 'dir') {
    return `${shared}<D:resourcetype><D:collection/></D:resourcetype>`;
  }
  const { size, contentType, etag } =
    node.kind === 'link'
      ? davLinkView(node)
      : {
          size: node.size,
          contentType: node.contentType ?? 'application/octet-stream',
          etag: etagFor(node),
        };
  return (
    `${shared}<D:resourcetype/>` +
    `<D:getcontentlength>${size}</D:getcontentlength>` +
    `<D:getcontenttype>${escapeXml(contentType)}</D:getcontenttype>` +
    `<D:getetag>${escapeXml(etag)}</D:getetag>`
  );
}

/**
 * A `207 Multi-Status` body for PROPFIND. Every property is reported found, so
 * there is a single `200 OK` propstat per response; clients such as rclone
 * treat a `404` propstat as an error.
 */
export function renderMultistatus(base: string, nodes: FsNode[]): string {
  const responses = nodes
    .map(
      (node) =>
        `<D:response><D:href>${escapeXml(hrefFor(base, node))}</D:href>` +
        `<D:propstat><D:prop>${propsFor(node)}</D:prop>` +
        `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`
  );
}

/** A `DAV:error` body carrying one precondition element. */
export function renderDavError(element: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<D:error xmlns:D="DAV:"><D:${element}/></D:error>`
  );
}

/**
 * Parse a single-range `Range` header. Undefined for no range or a
 * malformed/multi-range header, in which case the whole file is served.
 */
export function parseRange(
  header: string | undefined,
): FsByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '') {
    if (rawEnd === '') return undefined;
    return { suffixLength: Number(rawEnd) };
  }
  const start = Number(rawStart);
  const endExclusive = rawEnd === '' ? undefined : Number(rawEnd) + 1;
  return { start, endExclusive };
}

function httpStatusFor(code: FsErrorCode): number {
  switch (code) {
    case 'NotFound':
      return 404;
    case 'NotPermitted':
      return 403;
    case 'Unavailable':
      return 503;
    case 'IoError':
      return 502;
  }
}

/** A range read through the positional handle, for filesystems without streams. */
async function openViaHandle(
  fs: SharedFilesystem,
  node: FsNode,
  range: FsByteRange | undefined,
  signal: AbortSignal,
  peer: string | undefined,
): Promise<FsOpenedStream> {
  const { start, end } = resolveRange(range, node.size);
  const handle = await fs.open(node, { peer });
  let offset = start;
  const stream = new Readable({
    highWaterMark: HANDLE_CHUNK,
    read() {
      if (offset >= end || signal.aborted) {
        this.push(null);
        return;
      }
      handle
        .read(offset, Math.min(HANDLE_CHUNK, end - offset))
        .then((data) => {
          if (data.length === 0) {
            this.push(null);
            return;
          }
          offset += data.length;
          this.push(data);
        })
        .catch((err) => this.destroy(err));
    },
    destroy(err, cb) {
      void handle.close().finally(() => cb(err));
    },
  });
  return { stream, size: node.size, start, end };
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function sendInline(
  req: IncomingMessage,
  res: ServerResponse,
  meta: { etag: string; modified: Date; contentType: string },
  text: string,
): void {
  res.setHeader('ETag', meta.etag);
  res.setHeader('Last-Modified', meta.modified.toUTCString());
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'none');
  sendText(req, res, 200, `${meta.contentType}; charset=utf-8`, text);
}

function matchesEtag(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  return value === '*' || value.split(',').some((t) => t.trim() === etag);
}

async function propfind(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebdavOptions,
  node: FsNode,
): Promise<void> {
  const depth = String(req.headers.depth ?? '1')
    .trim()
    .toLowerCase();
  if (depth === 'infinity') {
    sendText(
      req,
      res,
      403,
      'application/xml; charset=utf-8',
      renderDavError('propfind-finite-depth'),
    );
    return;
  }
  const nodes: FsNode[] = [node];
  if (depth !== '0' && node.kind === 'dir') {
    const children = await opts.fs.readdir(node);
    nodes.push(
      ...(opts.links === 'hide'
        ? children.filter((c) => c.kind !== 'link')
        : children),
    );
  }
  sendText(
    req,
    res,
    207,
    'application/xml; charset=utf-8',
    renderMultistatus(opts.base, nodes),
  );
}

async function get(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebdavOptions,
  node: FsNode,
): Promise<void> {
  const log = opts.logger ?? silentLogger;
  if (node.kind === 'dir') {
    res.setHeader('Allow', ALLOW);
    sendText(
      req,
      res,
      405,
      'text/plain',
      'Collections are listed with PROPFIND',
    );
    return;
  }
  if (node.kind === 'link') {
    const view = davLinkView(node);
    sendInline(req, res, { ...view, modified: node.modified }, view.text);
    return;
  }

  const etag = etagFor(node);
  if (matchesEtag(req.headers['if-none-match'], etag)) {
    res.setHeader('ETag', etag);
    res.statusCode = 304;
    res.end();
    return;
  }
  const requested = parseRange(
    Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range,
  );
  // Includes `bytes=-0`, which resolves to start == size.
  if (requested && resolveRange(requested, node.size).start >= node.size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${node.size}`);
    res.end();
    return;
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);
  let opened: FsOpenedStream | undefined;
  try {
    opened = opts.fs.openStream
      ? await opts.fs.openStream(node, requested, controller.signal, {
          peer: opts.peer,
        })
      : await openViaHandle(
          opts.fs,
          node,
          requested,
          controller.signal,
          opts.peer,
        );
    const { size, start, end, stream } = opened;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', node.modified.toUTCString());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Type',
      node.contentType ?? 'application/octet-stream',
    );
    res.setHeader('Content-Length', String(end - start));
    if (requested) {
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end - 1}/${size}`);
    } else {
      res.statusCode = 200;
    }
    if (req.method === 'HEAD') {
      stream.destroy();
      res.end();
      return;
    }
    // Not `pipeline`: a source error before the first byte must still get a
    // status line, and pipeline would have torn the response down already.
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      res.once('error', reject);
      res.once('finish', resolve);
      res.once('close', resolve);
      stream.pipe(res);
    });
  } catch (err) {
    if (opened && !opened.stream.destroyed) opened.stream.destroy();
    if (controller.signal.aborted) {
      log.debug({ path: node.path }, 'client left during webdav transfer');
      return;
    }
    if (res.headersSent) {
      log.warn(
        { err, path: node.path },
        'webdav transfer failed after headers',
      );
      res.destroy();
      return;
    }
    const code = fsErrorCode(err);
    log.warn({ err, path: node.path, code }, 'webdav stream failed to open');
    sendText(
      req,
      res,
      httpStatusFor(code),
      'text/plain',
      err instanceof Error ? err.message : 'stream failed',
    );
  } finally {
    res.removeListener('close', onClose);
    if (opened && !opened.stream.destroyed) opened.stream.destroy();
  }
}

async function remove(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebdavOptions,
  node: FsNode,
): Promise<void> {
  if (!node.removable) {
    sendText(req, res, 403, 'text/plain', 'Read-only');
    return;
  }
  const outcome = await opts.fs.remove(node);
  switch (outcome) {
    case 'removed':
      res.statusCode = 204;
      res.end();
      return;
    case 'missing':
      sendText(req, res, 404, 'text/plain', 'Not Found');
      return;
    case 'denied':
      sendText(req, res, 403, 'text/plain', 'Read-only');
      return;
    case 'failed':
      sendText(req, res, 500, 'text/plain', 'Remove failed');
      return;
  }
}

function requestPath(req: IncomingMessage, opts: WebdavOptions): string {
  if (opts.path !== undefined) return opts.path;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const base = opts.base.replace(/\/$/, '');
  const path = url.pathname;
  if (base && (path === base || path.startsWith(`${base}/`))) {
    return path.slice(base.length) || '/';
  }
  return path;
}

/** Answer one WebDAV request; always ends the response. */
export async function handleWebdav(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebdavOptions,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.setHeader('DAV', '1');
    res.setHeader('Allow', ALLOW);
    res.setHeader('MS-Author-Via', 'DAV');
    res.statusCode = 200;
    res.end();
    return;
  }
  if (!METHODS.has(method)) {
    res.setHeader('Allow', ALLOW);
    res.statusCode = 405;
    res.end();
    return;
  }
  // Request bodies (PROPFIND prop lists) are ignored: every property we have
  // is always returned.
  req.resume();
  const node = await resolveDavPath(
    opts.fs,
    requestPath(req, opts),
    opts.links,
  );
  if (!node) {
    sendText(req, res, 404, 'text/plain', 'Not Found');
    return;
  }
  if (method === 'PROPFIND') await propfind(req, res, opts, node);
  else if (method === 'DELETE') await remove(req, res, opts, node);
  else await get(req, res, opts, node);
}
