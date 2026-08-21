/**
 * How a folder of solver exports is interpreted.
 *
 * One set of rules, used by both the Node build script (which indexes data
 * committed to the repo) and the browser folder picker (which reads a directory
 * off the user's disk without uploading it), so a layout that works in one
 * place works in the other.
 *
 * Recognised shapes, in order of preference:
 *
 *   <pair>/orbits*.csv                     initial conditions for the run
 *   <pair>/n<k>/*.csv                      solutions for the k-impulse solver
 *   <pair>/transfers*_n<k>.csv             the same, as a flat file
 *   transfers_<DEP>_to_<ARR>_n<k>.csv      flat at the root; the pair comes
 *                                          from the filename
 *
 * Anything else is reported as unrecognised rather than silently dropped.
 */

const CSV = /\.csv$/i;
const FLAT = /^transfers_(.+?)_to_(.+?)_n(\d+)\.csv$/i;
const NDIR = /^n(\d+)$/i;
const NSUFFIX = /_n(\d+)\.csv$/i;
const ORBITS = /^orbits.*\.csv$/i;

/**
 * @param {string[]} paths POSIX-style paths relative to the chosen root
 * @returns {{pairs: Array, ignored: string[]}}
 */
export function groupFiles(paths) {
  const pairs = new Map();
  const ignored = [];

  const pair = (key) => {
    if (!pairs.has(key)) {
      pairs.set(key, { key, orbitsFile: null, byN: new Map(), label: labelFor(key) });
    }
    return pairs.get(key);
  };

  for (const p of paths) {
    if (!CSV.test(p)) { if (!p.endsWith('/')) ignored.push(p); continue; }
    const seg = p.split('/').filter(Boolean);
    const name = seg[seg.length - 1];

    const flat = FLAT.exec(name);
    if (flat) {
      const key = seg.length > 1 ? seg[seg.length - 2] : `${flat[1]}_to_${flat[2]}`;
      addFile(pair(NDIR.test(key) ? `${flat[1]}_to_${flat[2]}` : key), Number(flat[3]), p);
      continue;
    }

    if (ORBITS.test(name)) {
      const key = seg.length > 1 ? seg[seg.length - 2] : '_root';
      pair(key).orbitsFile = p;
      continue;
    }

    const dir = seg.length > 1 ? seg[seg.length - 2] : null;
    const nDir = dir && NDIR.exec(dir);
    if (nDir) {
      const key = seg.length > 2 ? seg[seg.length - 3] : '_root';
      addFile(pair(key), Number(nDir[1]), p);
      continue;
    }

    const suffix = NSUFFIX.exec(name);
    if (suffix && dir) {
      addFile(pair(dir), Number(suffix[1]), p);
      continue;
    }

    ignored.push(p);
  }

  const out = [];
  for (const p of pairs.values()) {
    if (!p.byN.size) { if (!p.orbitsFile) continue; }
    const [dep, arr] = splitPair(p.key);
    out.push({
      key: p.key,
      label: p.label,
      depFamily: dep,
      arrFamily: arr,
      orbitsFile: p.orbitsFile,
      impulses: [...p.byN.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, files]) => ({ n, files })),
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return { pairs: out, ignored };
}

function addFile(p, n, path) {
  if (!p.byN.has(n)) p.byN.set(n, []);
  p.byN.get(n).push(path);
}

export function splitPair(key) {
  const m = /^(.+?)(?:__|_to_)(.+)$/.exec(key);
  return m ? [m[1], m[2]] : [null, null];
}

export function labelFor(key) {
  const [dep, arr] = splitPair(key);
  const pretty = (s) => (s ?? '').replace(/_/g, ' ');
  return dep ? `${pretty(dep)} → ${pretty(arr)}` : key.replace(/_/g, ' ');
}
