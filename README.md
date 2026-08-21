# Transfer Visualizer

Web visualization for periodic orbits and impulsive transfer trajectories in the
Earth–Moon circular restricted three-body problem (CR3BP). Fully static, no
backend, deployable to GitHub Pages.

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

`scripts/export_edges.m` reduces a folder of those to the CSV the site reads. Per
(pairing, TOF slice) it keeps the minimum-Δv solution plus up to two more that are
genuinely *distinct* branches (first burn differing in direction or magnitude),
and records how many seeds converged there so the density of the multistart stays
visible without shipping it.

```matlab
export_edges('edges_L1_Halo_to_L2_Halo', 'site_data')
```

---

## Two ways to supply solution data

**Committed to the repo** — put CSVs under `public/data/transfers/` and run
`node scripts/build_data_index.mjs`. Small, shareable, works on a cold link.

**A folder on your disk** — use *Data source → Choose folder* in the sidebar.
The browser reads the files directly; nothing is uploaded and nothing is
committed, so a full multistart export that would never fit in a repository can
still be explored. This also accepts the solver's own `edges_*/edge_*.mat`
folders — no MATLAB export step (see below).

Both paths use the same layout rules (`src/lib/layout.js`), so a folder that
works one way works the other:

```
<pair>/orbits*.csv                    initial conditions for the run (optional)
<pair>/n<k>/*.csv                     k-impulse solutions
<pair>/transfers*_n<k>.csv            the same, flat
transfers_<DEP>_to_<ARR>_n<k>.csv     flat at the root
edges_<DEP>_to_<ARR>/edge_*.mat       the solver's raw output
```

The **impulse count is never hardcoded**. The reader discovers how many `dvN_*`
and `t_legN` columns a file actually has, and the selector is built from the
`n<k>` folders present, so a 4- or 5-impulse export drops in with no code change.

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
The header shows *ICs from catalog* when that fallback is in use.

---

## Reading .mat without MATLAB

The site reads MATLAB v5/v7 files directly, so a folder of `edge_*.mat` works
without `export_edges.m` and without a Python step. Two things make that harder
than it sounds.

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

A pairing file is ~22k solutions and about 1.8 MB, which decompresses to ~7.5 MB.
Parsing and reducing one takes ~0.4 s, and it happens in the worker pool, so a
100-pairing sweep reads in roughly ten seconds with a progress bar and neither
the raw rows nor the decompressed subsystem ever reach the main thread.

`scripts/export_edges.m` still exists, and is the better route when you want the
reduced CSVs committed to the repository so the published site has data.

### Reproducing the published phases

Reconstructing an arc from the exported `Departure_Phase` / `Arrival_Phase` does
**not** land on the arrival orbit to the solver's own accuracy. Measured over one
pairing file, 60 rank-1 arcs:

| quantity | value |
|---|---|
| stored `Position_Residual` | ≤ 1.3e-9 |
| gap using the published phases, median | 1.2e-3 (≈ 480 km) |
| gap to the *nearest* point on the arrival orbit | 2.6e-4 (≈ 100 km) |
| gap after fitting both phases, median | **1.7e-9** |
| phase correction needed, mean | +0.21 / +0.83 cells of 1/360 |

The last two rows are the finding: **the burns, the time of flight and the orbits
are all exactly right.** Correcting the two reported phases by a fraction of one
phase-array cell brings the arc back to 1.7e-9 — the solver's own residual. So
this is a reporting error in the phase labels, not a physics or accuracy problem.

Four checks rule out the alternatives:

- it is not integration error — the gap does not grow with time of flight, a TOF
  of 0.1 shows the same ~3e-3 as a TOF of 2.7;
- it is not the phase array's resolution — linear interpolation of a 360-point
  array gives the same answer as exact propagation to the phase;
- it is not the loose tolerance on those arrays — reproducing `ode89`'s
  `RelTol 1e-7 / AbsTol 1e-8` moves the endpoint states by only ~2e-6, which is a
  floor on reproducibility but two orders too small;
- it is not a clean off-by-one either — adding exactly `1/360` to the arrival
  phase improves the median from 1.2e-3 to 3.2e-4 but does not close it, and the
  per-arc correction scatters between 0 and ~1.8 cells.

That signature — a correction under one grid cell, varying per arc — is what a
phase reported from the **phase-array index** rather than the continuous value
the solver optimised looks like, with the arrival index about one cell short.
The fix at the source is for `solve_direct_transfer.m` to report the continuous
`theta` it actually used, and to check the index-to-phase mapping (1-based index
`i` corresponds to phase `(i-1)/(N-1)` for `linspace(0, T, N)`).

Until then the site does two things rather than quietly drawing a trajectory that
misses its target:

- the readout reports the reconstruction gap, the gap after fitting, and the
  phase correction in grid cells, flagged when the gap exceeds 1e-4;
- **Fit phases so the arc closes** solves for the phases that actually close the
  transfer and draws that trajectory — the one the solver found. It costs about
  40 ms per arc and runs in the worker pool.

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
  export_edges.m            MATLAB: reduce edge_*.mat -> site CSV
  make_sample_transfers.mjs generate a demo dataset by solving the BVP
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

The demo dataset under `public/data/transfers/*_DEMO/` is generated by
`make_sample_transfers.mjs` — real converged two-impulse solutions from a coarse
phase grid, not research data. Delete that folder once the real exports land.

Nothing under `.mat` is committed: the source catalog and the solver's
`edge_*.mat` files stay with the research code, and the repository carries only
what the site actually serves.
