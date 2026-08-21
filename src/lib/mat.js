/**
 * A MAT-file (v5 / v7) reader, enough of one to read the research data directly
 * in the browser.
 *
 * Two things it has to handle that a naive reader gets wrong:
 *
 *   1. Every data element is padded to an 8-byte boundary EXCEPT `miCOMPRESSED`,
 *      which is written back-to-back. Padding it anyway walks the reader off the
 *      element boundary a couple of variables in, and the file then looks
 *      corrupt rather than misparsed.
 *
 *   2. A MATLAB `table` is not a struct. It is serialised as an opaque MCOS
 *      object whose payload lives in a separate, unnamed subsystem variable at
 *      the end of the file. `readTable` digs it out — see mat-table.js.
 *
 * v7.3 files are HDF5 rather than MAT5 and are not supported; they are detected
 * and reported rather than misread.
 */

const miINT8 = 1, miUINT8 = 2, miINT16 = 3, miUINT16 = 4, miINT32 = 5, miUINT32 = 6;
const miSINGLE = 7, miDOUBLE = 9, miINT64 = 12, miUINT64 = 13;
const miMATRIX = 14, miCOMPRESSED = 15, miUTF8 = 16, miUTF16 = 17, miUTF32 = 18;

const mxCELL = 1, mxSTRUCT = 2, mxOBJECT = 3, mxCHAR = 4, mxOPAQUE = 17;

const READERS = {
  [miINT8]: (dv, o, n, le) => readTyped(Int8Array, dv, o, n, 1, le),
  [miUINT8]: (dv, o, n, le) => readTyped(Uint8Array, dv, o, n, 1, le),
  [miINT16]: (dv, o, n, le) => readTyped(Int16Array, dv, o, n, 2, le),
  [miUINT16]: (dv, o, n, le) => readTyped(Uint16Array, dv, o, n, 2, le),
  [miINT32]: (dv, o, n, le) => readTyped(Int32Array, dv, o, n, 4, le),
  [miUINT32]: (dv, o, n, le) => readTyped(Uint32Array, dv, o, n, 4, le),
  [miSINGLE]: (dv, o, n, le) => readTyped(Float32Array, dv, o, n, 4, le),
  [miDOUBLE]: (dv, o, n, le) => readTyped(Float64Array, dv, o, n, 8, le),
  [miINT64]: (dv, o, n, le) => readTyped(BigInt64Array, dv, o, n, 8, le),
  [miUINT64]: (dv, o, n, le) => readTyped(BigUint64Array, dv, o, n, 8, le),
  [miUTF8]: (dv, o, n, le) => readTyped(Uint8Array, dv, o, n, 1, le),
  [miUTF16]: (dv, o, n, le) => readTyped(Uint16Array, dv, o, n, 2, le),
  [miUTF32]: (dv, o, n, le) => readTyped(Uint32Array, dv, o, n, 4, le),
};

function readTyped(Ctor, dv, off, nbytes, size, le) {
  const count = Math.floor(nbytes / size);
  const base = dv.byteOffset + off;
  // A typed-array view needs the right alignment and the file's byte order to
  // match the platform's; fall back to an element-wise copy when either fails.
  if (le && base % size === 0) {
    return new Ctor(dv.buffer, base, count);
  }
  const out = new Ctor(count);
  const get = {
    1: Ctor === Int8Array ? 'getInt8' : 'getUint8',
    2: Ctor === Int16Array ? 'getInt16' : 'getUint16',
    4: Ctor === Int32Array ? 'getInt32' : Ctor === Uint32Array ? 'getUint32' : 'getFloat32',
    8: Ctor === Float64Array ? 'getFloat64' : Ctor === BigInt64Array ? 'getBigInt64' : 'getBigUint64',
  }[size];
  for (let i = 0; i < count; i++) out[i] = dv[get](off + i * size, le);
  return out;
}

class Cursor {
  constructor(dv, le, start = 0, end = dv.byteLength) {
    this.dv = dv;
    this.le = le;
    this.p = start;
    this.end = end;
  }

  atEnd() { return this.p >= this.end - 7; }

  /** Reads a tag, handling the compressed "small data element" form. */
  next() {
    const raw = this.dv.getUint32(this.p, this.le);
    let type, nbytes, dataOff;
    if ((raw >>> 16) !== 0) {
      type = raw & 0xffff;
      nbytes = (raw >>> 16) & 0xffff;
      dataOff = this.p + 4;
      this.p += 8;
    } else {
      type = raw;
      nbytes = this.dv.getUint32(this.p + 4, this.le);
      dataOff = this.p + 8;
      const pad = type === miCOMPRESSED ? 0 : (8 - (nbytes % 8)) % 8;
      this.p = this.p + 8 + nbytes + pad;
    }
    return { type, nbytes, dataOff };
  }
}

const decodeChars = (arr) => {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < arr.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return s.replace(/\0+$/, '');
};

/** Parse the body of one miMATRIX element. */
function parseMatrix(dv, le, start, end) {
  if (end - start < 8) return { kind: 'empty', dims: [0, 0] };
  const c = new Cursor(dv, le, start, end);

  const t0 = c.next();
  const flags = READERS[t0.type](dv, t0.dataOff, t0.nbytes, le);
  const cls = flags[0] & 0xff;
  const logical = ((flags[0] >>> 8) & 0x02) !== 0;

  const readEl = () => {
    const t = c.next();
    return t;
  };
  const asChars = (t) => decodeChars(READERS[t.type](dv, t.dataOff, t.nbytes, le));

  if (cls === mxOPAQUE) {
    // No dims element: flags, then variable name / type system / class name,
    // then the payload.
    const name = asChars(readEl());
    const typeSystem = asChars(readEl());
    const className = asChars(readEl());
    const t = readEl();
    return {
      kind: 'opaque', name, typeSystem, className,
      value: t.type === miMATRIX
        ? parseMatrix(dv, le, t.dataOff, t.dataOff + t.nbytes)
        : READERS[t.type](dv, t.dataOff, t.nbytes, le),
    };
  }

  const td = readEl();
  const dims = Array.from(READERS[td.type](dv, td.dataOff, td.nbytes, le), Number);
  const name = asChars(readEl());
  const count = dims.reduce((a, b) => a * b, 1);

  if (cls === mxCELL) {
    const cells = [];
    for (let i = 0; i < count; i++) {
      const t = readEl();
      cells.push(t.type === miMATRIX
        ? parseMatrix(dv, le, t.dataOff, t.dataOff + t.nbytes)
        : { kind: 'raw', value: READERS[t.type]?.(dv, t.dataOff, t.nbytes, le) });
    }
    return { kind: 'cell', name, dims, cells };
  }

  if (cls === mxSTRUCT || cls === mxOBJECT) {
    let className = null;
    if (cls === mxOBJECT) className = asChars(readEl());
    const tlen = readEl();
    const fieldLen = READERS[tlen.type](dv, tlen.dataOff, tlen.nbytes, le)[0];
    const tnames = readEl();
    const nameBytes = READERS[miINT8](dv, tnames.dataOff, tnames.nbytes, le);
    const nFields = Math.floor(tnames.nbytes / fieldLen);
    const fields = [];
    for (let i = 0; i < nFields; i++) {
      fields.push(decodeChars(new Uint8Array(
        nameBytes.buffer, nameBytes.byteOffset + i * fieldLen, fieldLen
      )));
    }
    const records = [];
    for (let r = 0; r < count; r++) {
      const rec = {};
      for (const f of fields) {
        const t = readEl();
        rec[f] = t.type === miMATRIX
          ? parseMatrix(dv, le, t.dataOff, t.dataOff + t.nbytes)
          : { kind: 'raw', value: READERS[t.type]?.(dv, t.dataOff, t.nbytes, le) };
      }
      records.push(rec);
    }
    return { kind: 'struct', name, dims, fields, records, className };
  }

  if (cls === mxCHAR) {
    const t = readEl();
    return { kind: 'char', name, dims, value: asChars(t) };
  }

  const t = readEl();
  const value = READERS[t.type]?.(dv, t.dataOff, t.nbytes, le) ?? new Float64Array(0);
  return { kind: 'num', name, dims, value, logical };
}

/**
 * MAT stores zlib-wrapped deflate, which is what DecompressionStream('deflate')
 * expects (as opposed to 'deflate-raw').
 *
 * A solver run that was interrupted mid-save leaves the final deflate block
 * unterminated. The stream is otherwise complete and every row but the last few
 * is recoverable, but strict inflation rejects the whole thing with a bare
 * Z_BUF_ERROR — which loses an entire pairing over a missing checksum. Under
 * Node the retry finishes with Z_SYNC_FLUSH and keeps what is there; browsers
 * have no permissive mode, so there the failure stands with a clear message.
 */
async function inflate(bytes, stats) {
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    const recovered = await inflateTruncated(bytes);
    if (recovered) {
      if (stats) stats.truncated = true;
      return recovered;
    }
    throw new Error(
      'a compressed block could not be inflated — the file looks corrupt or was ' +
      'truncated mid-save'
    );
  }
}

async function inflateTruncated(bytes) {
  if (!globalThis.process?.versions?.node) return null;
  try {
    // Computed specifier so bundlers do not try to resolve node:zlib for the
    // browser build.
    const spec = 'node:zlib';
    const zlib = await import(/* @vite-ignore */ spec);
    return await new Promise((resolve) => {
      zlib.inflate(bytes, { finishFlush: zlib.constants.Z_SYNC_FLUSH }, (e, buf) =>
        resolve(e ? null : new Uint8Array(buf)));
    });
  } catch {
    return null;
  }
}

/**
 * Read a MAT-file.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{header: string, vars: Map<string, object>, subsystem: Uint8Array|null}>}
 */
export async function readMat(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 128) throw new Error('not a MAT-file: too short');

  const magic = decodeChars(bytes.subarray(0, 8));
  if (magic.startsWith('\x89HDF')) {
    throw new Error('this is a MAT v7.3 (HDF5) file; re-save with -v7 or use writetable');
  }
  const header = decodeChars(bytes.subarray(0, 116)).trim();
  const endianTag = String.fromCharCode(bytes[126], bytes[127]);
  if (endianTag !== 'IM' && endianTag !== 'MI') throw new Error('not a MAT-file: bad endian marker');
  const le = endianTag === 'IM';

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = new Cursor(dv, le, 128, bytes.byteLength);

  const vars = new Map();
  const stats = { truncated: false };
  let subsystem = null;

  while (!c.atEnd()) {
    const t = c.next();
    if (t.type === miCOMPRESSED) {
      const raw = await inflate(
        new Uint8Array(bytes.buffer, bytes.byteOffset + t.dataOff, t.nbytes), stats
      );
      const idv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const ic = new Cursor(idv, le, 0, raw.byteLength);
      const it = ic.next();
      if (it.type !== miMATRIX) continue;
      const m = parseMatrix(idv, le, it.dataOff, it.dataOff + it.nbytes);
      store(vars, m);
      if (isSubsystem(m)) subsystem = m.value;
    } else if (t.type === miMATRIX) {
      const m = parseMatrix(dv, le, t.dataOff, t.dataOff + t.nbytes);
      store(vars, m);
      if (isSubsystem(m)) subsystem = m.value;
    }
  }

  return { header, vars, subsystem, littleEndian: le, truncated: stats.truncated };
}

// MATLAB writes the MCOS subsystem as a trailing, unnamed uint8 variable.
const isSubsystem = (m) =>
  m.kind === 'num' && !m.name && m.value instanceof Uint8Array && m.value.length > 16;

function store(vars, m) {
  if (m.name) vars.set(m.name, m);
}

/**
 * Parse the subsystem blob. It is itself a MAT5 stream (minus the 128-byte
 * header) whose single variable is a struct with an `MCOS` opaque field holding
 * the FileWrapper cell array — where every object's property values live.
 */
export function parseSubsystem(bytes, le = true) {
  if (!bytes || bytes.length < 16) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = new Cursor(dv, le, 8, bytes.byteLength);
  const t = c.next();
  if (t.type !== miMATRIX) return null;
  const m = parseMatrix(dv, le, t.dataOff, t.dataOff + t.nbytes);
  const mcos = m?.records?.[0]?.MCOS;
  if (!mcos || mcos.kind !== 'opaque') return null;
  return mcos.value; // the FileWrapper cell
}

export { parseMatrix, decodeChars };
