/**
 * Where transfer solutions come from.
 *
 * Two interchangeable sources behind one interface:
 *
 *   RemoteSource — data committed to the repository and served with the site.
 *                  Small, shareable, works on a cold link.
 *   LocalSource  — a folder chosen from disk. Nothing is uploaded: the browser
 *                  reads the files directly, so a full multistart export that
 *                  would never fit in a repo can still be explored.
 *
 * Both expose the same two calls, so the store and the views never know which
 * one is in play.
 */

import { groupFiles } from './layout.js';

export class RemoteSource {
  /** @param {string} base URL of the transfers directory */
  constructor(base, manifest) {
    this.kind = 'remote';
    this.name = 'repository data';
    this.base = base.replace(/\/$/, '');
    this.manifest = manifest;
  }

  static async open(base) {
    const r = await fetch(`${base.replace(/\/$/, '')}/index.json`);
    if (!r.ok) throw new Error(`no transfer index at ${base}`);
    return new RemoteSource(base, await r.json());
  }

  listPairs() {
    return this.manifest.pairs ?? [];
  }

  /**
   * `relPath` comes from the manifest and is already relative to the transfers
   * root, pair folder included — the same convention the local source uses, so
   * neither one re-prefixes the pair key.
   */
  async readText(_pairKey, relPath) {
    const r = await fetch(`${this.base}/${relPath}`);
    if (!r.ok) throw new Error(`${relPath}: ${r.status}`);
    return r.text();
  }
}

export class LocalSource {
  /**
   * @param {string} name folder name, for display
   * @param {Map<string, File>} files path (relative to the chosen folder) -> File
   */
  constructor(name, files) {
    this.kind = 'local';
    this.name = name;
    this.files = files;
    const { pairs, ignored } = groupFiles([...files.keys()]);
    this.pairs = pairs;
    this.ignored = ignored;
    // Paths are absolute within the chosen folder, so pair-relative reads have
    // to be resolved back against the full path list.
    this.byPair = new Map(pairs.map((p) => [p.key, p]));
  }

  /**
   * Build from an `<input type="file" webkitdirectory>` FileList. The first
   * path segment is the chosen folder itself and is stripped.
   */
  static fromFileList(fileList) {
    const files = new Map();
    let root = '';
    for (const f of fileList) {
      const rel = f.webkitRelativePath || f.name;
      const seg = rel.split('/');
      if (seg.length > 1) {
        root ||= seg[0];
        files.set(seg.slice(1).join('/'), f);
      } else {
        files.set(rel, f);
      }
    }
    return new LocalSource(root || 'selected folder', files);
  }

  /** Build from the File System Access API, where it is available. */
  static async fromDirectoryHandle(handle) {
    const files = new Map();
    const walk = async (dir, prefix, depth) => {
      if (depth > 4) return;
      for await (const [name, entry] of dir.entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === 'file') files.set(p, await entry.getFile());
        else await walk(entry, p, depth + 1);
      }
    };
    await walk(handle, '', 0);
    return new LocalSource(handle.name, files);
  }

  listPairs() {
    return this.pairs;
  }

  async readText(pairKey, relPath) {
    // `relPath` from groupFiles is already relative to the chosen folder.
    const f = this.files.get(relPath) ?? this.files.get(`${pairKey}/${relPath}`);
    if (!f) throw new Error(`missing file: ${relPath}`);
    return f.text();
  }

  get totalBytes() {
    let n = 0;
    for (const f of this.files.values()) n += f.size;
    return n;
  }
}

/** True when the browser offers the directory picker (Chromium today). */
export const hasDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
