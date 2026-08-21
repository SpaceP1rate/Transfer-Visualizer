# Transfer Visualizer

**A. Hakobyan**

An exact-solution viewer for periodic orbits and impulsive transfer trajectories
in the Earth–Moon circular restricted three-body problem (CR3BP). Fully static,
no backend, deployable to GitHub Pages.

Everything the site draws comes from a solve folder committed under
`public/data/solutions/`. There is no upload path and no local-folder path: a
link to the site and a link to the commit describe the same thing.

Neither data source stores drawable geometry: the orbit catalog gives an initial
state and a period, the solver exports give phases, burn vectors and coast
durations. Everything you see is reconstructed in the browser by numerical
integration, which keeps the committed data tiny and lets the time-of-flight
slider be genuinely interactive.

---

## Quick start

```bash
npm install
npm test        # acceptance tests, against the committed catalog
npm run dev
```

The converted catalog is committed, so nothing above needs the source `.mat`.
To regenerate it — after a catalog refresh, or to add a family — point the
converter at your own copy:

```bash
python3 scripts/convert_mat.py ~/orbit\ selection/JPL_cr3bp_orbits.mat
node scripts/build_study.mjs        # reproduce the study's orbit sampling
node scripts/build_data_index.mjs   # index whatever transfer CSVs are present
```

`npm run build` produces `dist/`, which is what the GitHub Pages workflow
publishes.

---

## Where the numbers come from

### Orbit catalog

`JPL_cr3bp_orbits.mat` is the snapshot the MATLAB research code samples from,
and it is authoritative — member ordering and count match the transfer exports,
which a fresh API query would not. **It is not committed**: it lives alongside
the research code (`../../orbit selection/` in the MATLAB driver), and the
repository carries only the converted product.

`scripts/convert_mat.py` converts it to one flat little-endian `Float64` table
per family, `[x, y, z, vx, vy, vz, jacobi, period, stability]` per row, plus a
manifest. Loading a family is one fetch into an `ArrayBuffer` with no parse step
and no per-orbit allocation.

All thirteen families in the snapshot are converted — 3.6 MB — including the
ones no pair references yet (DRO, resonant 2:1, L4/L5 long and short period, the
NRHOs, the butterfly). Families are fetched lazily, one file each, so the unused
ones cost nothing at page load and are ready when a study pair reaches for them.
`--families L1_Halo,L2_Halo` narrows the conversion if you ever want a smaller
build.

`src/lib/mat.js` and `src/lib/mat-table.js` read MAT-files in the browser,
including the `edge_*.mat` tables — see "Reading .mat without MATLAB" below.

Float64 and not Float32: these initial conditions sit on strongly unstable orbits
(stability index up to ~1100), where a single-precision round trip visibly opens
the orbit within one revolution.

`scripts/fetch_orbits.mjs` refreshes the same data from JPL's Three-Body Periodic
Orbits API. It is a **build-time** script by necessity — NASA's SSD/CNEOS Fair
Use Policy forbids embedding the API in a website and requires one request at a
time — so it runs locally, sequentially, with a polite delay, and its output is
committed. The site never calls `ssd-api.jpl.nasa.gov`.

### Transfer solutions

The MATLAB driver saves one `edge_<DEP>_<dd>_to_<ARR>_<aa>.mat` per orbit pairing
under `edges_<DEP>_to_<ARR>/`. A full run is of order a million converged rows per
family pair — far too much to commit.

`scripts/reduce_solutions.mjs` turns those folders into the CSVs the site reads.
Per (pairing, TOF slice) it keeps the minimum-Δv solution plus up to two more that
are genuinely *distinct* branches (first burn differing in direction or
magnitude), and records how many seeds converged there so the density of the
multistart stays visible without shipping it.

```bash
node scripts/reduce_solutions.mjs      # every edges_* folder under solutions/
node scripts/build_data_index.mjs
```

It needs neither MATLAB nor any npm package — the MAT reader is in
`src/lib/mat.js`. On one study: **10.3M solutions across 401 files and 804 MB
became 72k rows and 21 MB, in about 15 seconds**. `scripts/export_edges.m` does
the same job inside MATLAB if you prefer.

The `edges_*` folders are matched by `.gitignore` and skipped by the indexer, so
the raw output stays on disk and only the reduced CSVs are committed.

---

## Supplying solutions

Put a solve folder under `public/data/solutions/` and run
`node scripts/build_data_index.mjs`. That walks the directory, validates what it
finds, and writes the manifest the site loads. The solution dropdown lists
exactly those folders and nothing else; when the directory is empty the site says
so and falls back to drawing all thirteen catalog families.

Recognised layouts (`src/lib/layout.js`):

```
public/data/solutions/
  <pair>/orbits*.csv                    initial conditions for the run (optional)
  <pair>/n<k>/*.csv                     k-impulse solutions
  <pair>/transfers*_n<k>.csv            the same, flat
  transfers_<DEP>_to_<ARR>_n<k>.csv     flat at the root
  edges_<DEP>_to_<ARR>_n<k>/edge_*.mat  raw solver output — reduce it, see below
```

The **impulse selector is the folder list**. It offers exactly the `n<k>`
directories that exist for the selected pair and nothing else — a solve with
`n2/` and `n3/` offers 2 and 3; a solve with only `n2/` offers 2 and is not
editable. There is no free-form number and no count guessed from the rows, so a
4- or 5-impulse export drops in with no code change and an absent one can never
be selected. Within a file the reader still discovers how many `dvN_*` and
`t_legN` columns are actually present, which is what lets a run with a zero
midcourse burn read correctly.

`edge_*.mat` files are read directly, with no MATLAB step (see below) — but a
full run is of order a million rows per family pair, so they are reduced at build
time rather than served.

### CSV columns

Column names are matched case-insensitively, and both the handoff schema and the
MATLAB `edge_table` names are accepted:

| meaning | accepted names |
|---|---|
| endpoints | `dep_orbit_id` / `arr_orbit_id`, or `From` / `To` |
| cost | `DV_total` |
| burns | `dv1_x…dv3_z`, optional `dvN_mag` |
| timing | `TOF`, `t_leg1`, `t_leg2`, optional `TOF_idx` |
| phases | `departure_phase`, `arrival_phase` (fraction of period, `[0,1)`) |
| screening | `min_moon_dist`, `lunar_valid` |
| provenance | `chain_id`, `position_residual`, `node_residual`, `rank`, `seeds_converged` |

If no `orbits*.csv` is supplied, initial conditions are resolved by label
(`L1_Halo_07`) from the catalog, reproducing `sample_family` exactly — mask on
`C ∈ [C_min, C_max]` in catalog order, then `round(linspace(1, n_total, 10))`.
The header shows *ICs from catalog* when that fallback is in use. Verified
against a solver file's own stored `C_dep` / `C_arr`: they agree to 4e-15.

---

## Reading .mat without MATLAB

The site reads MATLAB v5/v7 files directly, so a solve folder of `edge_*.mat`
works without `export_edges.m` and without a Python step. Two things make that
harder than it sounds.

**Element padding.** Every MAT data element is padded to an 8-byte boundary
*except* `miCOMPRESSED`, which is written back-to-back. Pad it anyway and the
reader walks off the element boundary two variables in, at which point the file
looks corrupt rather than misparsed.

**Tables are not structs.** A saved `table` is an opaque MCOS object: the
variable in the file is only a handle, and the contents live in an unnamed
subsystem variable at the end of the file, inside a `FileWrapper__` cell. Two of
its cells carry everything needed — one cell of N char arrays (the variable
names, in order) and one cell of N equal-length columns (the data). Rather than
hardcoding their positions, which have moved between MATLAB releases,
`extractTables` finds them by shape, so an unfamiliar layout fails loudly
instead of returning shifted columns.

A pairing file is 22k-37k solutions and a few megabytes, decompressing to ~7.5 MB.
Parsing and reducing one takes well under a second.

**Truncated files are recovered rather than dropped.** A run interrupted mid-save
leaves the final deflate block unterminated; strict inflation rejects the whole
file with a bare `Z_BUF_ERROR`, losing a whole pairing over a missing checksum.
Under Node the reader retries with `Z_SYNC_FLUSH`, keeps what is there, and says
which files it did that for.

### The phase convention

`departure_phase` and `arrival_phase` are **not** "propagate the orbit for
`phase x period`". Reading them that way leaves the arc a few hundred kilometres
short of the arrival orbit, and no amount of adjusting the phases closes the gap,
because the discrepancy is in the state rather than the timing.

The MATLAB run precomputes a table of `N = 360` states at `linspace(0, T, N)` and
reads it back by linear interpolation at continuous index `phase x N + 1`
(1-based; `check_solution.m` lines 167-171):

```matlab
idx_lo = floor(theta * N_phase) + 1;
idx_hi = mod(idx_lo, N_phase) + 1;
alpha  = (theta * N_phase) - floor(theta * N_phase);
X0_dep = (1-alpha)*X_dep(idx_lo,:) + alpha*X_dep(idx_hi,:);
```

Two things follow, and both matter:

- **the effective time is `phase x T x N/(N-1)`**, not `phase x T` — index
  `phase x N` in steps of `T/(N-1)` is not the same thing;
- **the state is a chord between two table entries**, not a point on the orbit.
  With 360 samples over a period the chord sits of order 1e-4 nd off the orbit,
  and the solver converged its burns against *that* state.

`phaseState` in `src/lib/trajectory.js` reproduces it exactly. Measured over 120
arcs of `L1_Halo_to_L2_Halo`:

| how the endpoints are taken | gap to the arrival orbit |
|---|---|
| propagating to `phase x period` | 1.8e-3 (≈ 700 km) |
| the run's phase-array convention | **2.0e-9 median, 1.1e-7 worst** |

2e-9 is the solver's own `Position_Residual`, so the reconstruction is exact and
nothing needs fitting or correcting. `PHASE_RESOLUTION` is the run's `N`; a study
that used a different table size must set it to match, which is why
`check_solution.m` carries the comment *"must match what was used"*.

The size of the error if you get this wrong scales with how unstable the orbit
is — it is barely visible on a small Lyapunov near L1 and reaches several
thousand kilometres on a large halo — which is what makes it easy to mistake for
an integration problem.

---

## Reconstruction and accuracy

The propagator is an adaptive Dormand–Prince 5(4) with FSAL and 4th-order dense
output (`src/lib/cr3bp.js`). Dense output matters: sampling 300–2000 points along
an arc costs interpolation rather than forced step subdivision.

The equations of motion are identical to `cr3bp_prop_mex.cpp`, so the two
implementations differ only in integrator and tolerance.

All propagation runs in a worker pool (`src/workers/propagate.worker.js`) and
geometry comes back as transferable `ArrayBuffer`s, so dragging a slider never
blocks the render loop. A whole family sweep is drawn as a single
`LineSegments` — one draw call however many members are shown.

### Acceptance tests

`npm test` runs against the real catalog, not synthetic data:

| check | result |
|---|---|
| μ matches the MATLAB run | 0.01215058560962404 |
| libration points vs JPL | max \|dx\| 2.2e-16 |
| stored Jacobi column reproduces from the state | 5.8e-15 |
| orbit closure over one period, 100 catalog orbits | 4.1e-9 |
| Jacobi drift over 5 periods | 4.5e-10 |
| dense output vs direct integration | 1.1e-11 |
| forward/backward propagation | 1.9e-12 |
| canonical monodromy symplectic, scaled by \|M\|² | 1.7e-12 |
| halo bifurcation vs catalog family endpoint | 1.2e-3 |
| transfer closure | 3.4e-10 |

Two of these are worth explaining.

**Symplecticity.** The CR3BP is Hamiltonian only in the conjugate momenta
`px = vx − y`, `py = vy + x`, `pz = vz`. An STM propagated in position/velocity
is *not* symplectic, and testing it directly fails by O(\|M\|²) — which looks
exactly like an integrator bug. `canonicalSTM` applies the transformation first.

**Independent cross-check.** `src/lib/periodic.js` continues an L1 Lyapunov
family from scratch by differential correction and locates the halo bifurcation
by tracking the out-of-plane block of the monodromy matrix (which decouples
exactly for a planar orbit) to trace 2. That bifurcation's Jacobi constant must
equal the catalog's L1 halo family endpoint — 3.17317 continued vs 3.17434 stored
— a completely independent path to the same number.

---

## Known discrepancy: the length unit

JPL's catalog normalises with **LU = 389703.2648 km**; the MATLAB code uses
**LU = 384400 km** (it computes the lunar radius as `1737.4/384400 = 0.0045198`).
These disagree by 1.4%.

Nondimensional geometry is unaffected — every arc, orbit and Δv in the study is
correct as a nondimensional quantity. What differs is:

- **any conversion to km or m/s.** The site uses JPL's `lunit`/`tunit` for
  display, so a Δv shown as 658.7 m/s would read 649.7 m/s under the MATLAB
  normalisation.
- **the lunar screening threshold.** `lunar_valid` was computed against
  `1737.4/384400 = 0.0045198`, about 1.4% larger than JPL's own
  `1737.1/389703.26 = 0.0044576`. The screen is therefore very slightly
  conservative; a handful of arcs flagged as impacts clear the surface under
  JPL's radius.

Worth deciding which normalisation the paper reports before the numbers are
quoted anywhere.

---

## Two findings the UI surfaces rather than hides

**Δv_n ≤ Δv_2 must hold.** The n-impulse feasible set contains the two-impulse
one, so a pair where the n-impulse solver came out dearer cannot be at a true
optimum. Those cells are outlined on the Δv surface and counted beneath it —
they mark solver local minima.

**Interior burns are often ~zero.** The readout always lists per-burn magnitudes
and flags a burn below 0.5 m/s as negligible, which is what makes visible whether
a "3-impulse" solution is genuinely three burns or a two-impulse trajectory found
by a better-conditioned solver.

---

## Colour

Colour is assigned by the job it does. Magnitude — Jacobi constant, Δv — uses one
sequential blue ramp. Identity — departure, arrival, transfer — uses three fixed
categorical slots validated all-pairs against the dark surface (worst CVD ΔE 9.4,
worst normal-vision ΔE 20.9, all ≥ 3:1 contrast). The two solver variants share a
hue and differ by lightness and dash pattern, since they are the same kind of
thing at different settings. Lunar impact uses the reserved critical red and is
always accompanied by a label.

Empty cells on the Δv surface are hatched rather than painted, because a gap in
the search must not read as a free transfer.

---

## Layout

```
scripts/
  convert_mat.py            catalog .mat -> binary tables + manifest
  fetch_orbits.mjs          refresh the catalog from JPL (build time only)
  build_study.mjs           reproduce sample_family from the catalog
  build_data_index.mjs      index committed transfer CSVs
  reduce_solutions.mjs      raw edge_*.mat -> committed solution CSVs
  export_edges.m            the same reduction inside MATLAB, if preferred
  acceptance.mjs            npm test
src/lib/
  cr3bp.js                  equations of motion, DP5(4) with dense output
  periodic.js               differential correction, family continuation
  trajectory.js             orbit and transfer reconstruction
  catalog.js                zero-copy loader for the binary tables
  csv.js                    schema-driven readers for the solver exports
  layout.js                 folder conventions, shared by Node and the browser
  source.js                 repository vs local-folder data sources
src/components/             Scene, Sidebar, DvSurface, Readout
```

Nothing under `.mat` is committed: the source catalog and the solver's
`edge_*.mat` files stay with the research code, and the repository carries only
what the site actually serves.
