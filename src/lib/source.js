/**
 * The solution source.
 *
 * This is an exact-solution viewer: everything it draws comes from a solve
 * folder committed under `public/data/solutions/`. There is no upload path and
 * no local-folder path — what the repository contains is what the site shows,
 * so a link to the site and a link to the commit describe the same thing.
 *
 * Folder conventions live in layout.js; `scripts/build_data_index.mjs` walks the
 * directory and writes the manifest this reads.
 */

export class SolutionsSource {
  constructor(base, manifest) {
    this.base = base.replace(/\/$/, '');
    this.manifest = manifest;
  }

  /** Returns null when no solutions are committed, rather than throwing. */
  static async open(base) {
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}/index.json`);
      if (!r.ok) return null;
      const manifest = await r.json();
      if (!manifest?.pairs?.length) return null;
      return new SolutionsSource(base, manifest);
    } catch {
      return null;
    }
  }

  listPairs() {
    return this.manifest.pairs ?? [];
  }

  /** Paths in the manifest are relative to the solutions root, folder included. */
  async readText(relPath) {
    const r = await fetch(`${this.base}/${relPath}`);
    if (!r.ok) throw new Error(`${relPath}: ${r.status}`);
    return r.text();
  }

  async readBinary(relPath) {
    const r = await fetch(`${this.base}/${relPath}`);
    if (!r.ok) throw new Error(`${relPath}: ${r.status}`);
    return r.arrayBuffer();
  }
}
