/** XDR (RFC 4506): big-endian, every item padded to a multiple of four. */
export class XdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XdrError';
  }
}

function padded(length: number): number {
  return (length + 3) & ~3;
}

export class XdrWriter {
  private buf: Buffer;
  private len = 0;

  constructor(initialSize = 256) {
    this.buf = Buffer.allocUnsafe(initialSize);
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < needed) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  uint32(value: number): this {
    this.ensure(4);
    this.buf.writeUInt32BE(value >>> 0, this.len);
    this.len += 4;
    return this;
  }

  int32(value: number): this {
    this.ensure(4);
    this.buf.writeInt32BE(value | 0, this.len);
    this.len += 4;
    return this;
  }

  uint64(value: bigint): this {
    this.ensure(8);
    this.buf.writeBigUInt64BE(BigInt.asUintN(64, value), this.len);
    this.len += 8;
    return this;
  }

  int64(value: bigint): this {
    this.ensure(8);
    this.buf.writeBigInt64BE(BigInt.asIntN(64, value), this.len);
    this.len += 8;
    return this;
  }

  bool(value: boolean): this {
    return this.uint32(value ? 1 : 0);
  }

  /** Fixed-length opaque: the bytes plus padding, no length prefix. */
  opaqueFixed(bytes: Uint8Array): this {
    const total = padded(bytes.length);
    this.ensure(total);
    this.buf.set(bytes, this.len);
    this.buf.fill(0, this.len + bytes.length, this.len + total);
    this.len += total;
    return this;
  }

  /** Variable-length opaque: length prefix, bytes, padding. */
  opaqueVar(bytes: Uint8Array): this {
    this.uint32(bytes.length);
    return this.opaqueFixed(bytes);
  }

  string(value: string): this {
    return this.opaqueVar(Buffer.from(value, 'utf8'));
  }

  /** Already-encoded XDR, appended as is. */
  raw(bytes: Uint8Array): this {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    return this;
  }

  /** Patch a uint32 written earlier (list counts, lengths known late). */
  patchUint32(offset: number, value: number): void {
    this.buf.writeUInt32BE(value >>> 0, offset);
  }

  /** Discard everything written after `length`. */
  truncate(length: number): void {
    if (length < this.len) this.len = length;
  }

  /** A view of what was written; invalidated by further writes. */
  bytes(): Buffer {
    return this.buf.subarray(0, this.len);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes());
  }
}

export class XdrReader {
  pos: number;
  private readonly end: number;

  constructor(
    private readonly buf: Buffer,
    start = 0,
    end = buf.length,
  ) {
    this.pos = start;
    this.end = end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new XdrError(`truncated: need ${n} bytes at ${this.pos}`);
    }
  }

  remaining(): number {
    return this.end - this.pos;
  }

  done(): boolean {
    return this.pos >= this.end;
  }

  uint32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  int32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  uint64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  int64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  bool(): boolean {
    return this.uint32() !== 0;
  }

  /** A view into the source buffer; copy it if it must outlive the record. */
  opaqueFixed(length: number): Buffer {
    const total = padded(length);
    this.need(total);
    const v = this.buf.subarray(this.pos, this.pos + length);
    this.pos += total;
    return v;
  }

  opaqueVar(max = Infinity): Buffer {
    const length = this.uint32();
    if (length > max) throw new XdrError(`opaque of ${length} exceeds ${max}`);
    return this.opaqueFixed(length);
  }

  string(max = Infinity): string {
    return this.opaqueVar(max).toString('utf8');
  }

  skip(bytes: number): void {
    this.need(bytes);
    this.pos += bytes;
  }
}
