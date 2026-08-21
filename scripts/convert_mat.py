#!/usr/bin/env python3
"""
Convert the MATLAB JPL catalog snapshot (JPL_cr3bp_orbits.mat) into the compact
binary form the site loads.

The snapshot is authoritative: it is the exact catalog the research run used, so
member ordering and count match the transfer CSVs. `scripts/fetch_orbits.mjs`
exists to refresh it from JPL, but this file is the source of truth.

Output, one file per family:

    public/data/orbits/<KEY>.f64      little-endian Float64, N rows x 9 columns
                                      [x, y, z, vx, vy, vz, jacobi, period, stability]
    public/data/orbits/index.json     manifest: counts, Jacobi/period ranges, constants

Float64 rather than Float32 throughout: these initial conditions sit on strongly
unstable orbits, where a single-precision round-trip (~1e-7 relative) visibly
opens the orbit within one revolution.

    python3 scripts/convert_mat.py path/to/JPL_cr3bp_orbits.mat
    python3 scripts/convert_mat.py --families L1_Halo,L2_Halo   # a subset

Every family in the snapshot is written by default (3.6 MB across 13 families).
Families load lazily, one fetch each, so the ones nothing selects cost nothing at
page load. The source .mat is not committed; point this script at your own copy
to regenerate.
"""

import json
import sys
from pathlib import Path

import numpy as np
import scipy.io

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "orbits"

# JPL's Earth-Moon system constants (periodic_orbits.api `system` block).
# The MATLAB research code normalises with LU = 384400 km instead; see README.
SYSTEM = {
    "name": "Earth-Moon",
    "mu": 0.01215058560962404,
    "radiusSecondaryKm": 1737.1,
    "lunitKm": 389703.2648292776,
    "tunitS": 382981.2891290545,
}
SYSTEM["vunitKmS"] = SYSTEM["lunitKm"] / SYSTEM["tunitS"]
SYSTEM["moonRadius"] = SYSTEM["radiusSecondaryKm"] / SYSTEM["lunitKm"]
SYSTEM["earthRadiusKm"] = 6378.137
SYSTEM["earthRadius"] = SYSTEM["earthRadiusKm"] / SYSTEM["lunitKm"]

# Display metadata. `branch` is filled in from the data, not assumed.
# The families the current study pairs use. Everything else is converted too —
# they load lazily and are wanted for later work — but these are the ones the
# acceptance tests exercise.
STUDY_FAMILIES = ["L1_Halo", "L2_Halo", "L1_Lyapunov", "L2_Lyapunov"]

LABELS = {
    "L1_Halo": ("L1 Halo", "halo", 1),
    "L2_Halo": ("L2 Halo", "halo", 2),
    "L1_Lyapunov": ("L1 Lyapunov", "lyapunov", 1),
    "L2_Lyapunov": ("L2 Lyapunov", "lyapunov", 2),
    "L1_NRHO": ("L1 NRHO", "halo", 1),
    "L2_NRHO": ("L2 NRHO", "halo", 2),
    "L2_Butterfly": ("L2 Butterfly", "butterfly", 2),
    "DRO": ("Distant Retrograde", "dro", None),
    "Resonant_21": ("Resonant 2:1", "resonant", None),
    "L4_Long": ("L4 Long-period", "longp", 4),
    "L4_Short": ("L4 Short-period", "short", 4),
    "L5_Long": ("L5 Long-period", "longp", 5),
    "L5_Short": ("L5 Short-period", "short", 5),
}


def jacobi(mu, X):
    x, y, z, vx, vy, vz = (X[:, i] for i in range(6))
    r1 = np.sqrt((x + mu) ** 2 + y * y + z * z)
    r2 = np.sqrt((x - 1 + mu) ** 2 + y * y + z * z)
    return x * x + y * y + 2 * (1 - mu) / r1 + 2 * mu / r2 - (vx * vx + vy * vy + vz * vz)


def main():
    argv = [a for a in sys.argv[1:] if a != "--all"]  # --all is now the default

    families = None
    if "--families" in argv:
        i = argv.index("--families")
        families = [f.strip() for f in argv[i + 1].split(",") if f.strip()]
        del argv[i:i + 2]

    src = Path(argv[0] if argv else ROOT / "JPL_cr3bp_orbits.mat")
    if not src.exists():
        sys.exit(
            f"not found: {src}\n"
            "The source catalog is not committed. Pass the path to your copy, e.g.\n"
            "  python3 scripts/convert_mat.py ~/orbit\\ selection/JPL_cr3bp_orbits.mat"
        )
    OUT.mkdir(parents=True, exist_ok=True)

    m = scipy.io.loadmat(src, struct_as_record=False, squeeze_me=True)
    mu = float(m["mu"])
    if abs(mu - SYSTEM["mu"]) > 1e-15:
        sys.exit(f"mass ratio mismatch: file has {mu!r}, expected {SYSTEM['mu']!r}")

    manifest = {"source": src.name, "system": SYSTEM, "families": []}

    present = sorted(k for k in m if not k.startswith("__") and k != "mu")
    if families:
        selected = [k for k in families if k in present]
        missing = [k for k in families if k not in present]
        if missing:
            print(f"  !! not in {src.name}: {', '.join(missing)}")
    else:
        selected = present
    skipped = [k for k in present if k not in selected]

    for k in STUDY_FAMILIES:
        if k not in selected:
            print(f"  !! {k} is used by the study pairs but was not selected")

    for key in selected:
        s = m[key]
        X = np.asarray(s.x0, dtype=np.float64)
        period = np.asarray(s.period, dtype=np.float64)
        stability = np.asarray(s.stability, dtype=np.float64)
        energy = np.asarray(s.energy, dtype=np.float64)

        # The stored `energy` should be the Jacobi constant in JPL's convention
        # (no mu*(1-mu) term). Verify rather than trust: a mismatch here would
        # silently shift every Jacobi-based lookup and colour scale.
        c = jacobi(mu, X)
        err = float(np.max(np.abs(c - energy)))
        if err > 1e-9:
            print(f"  !! {key}: `energy` differs from the Jacobi constant by {err:.2e}")

        # Halo branch, read off the data instead of assumed.
        # A family that runs into its planar bifurcation has a tail where z0 -> 0
        # and its sign is numerical noise, so judge the branch on members with a
        # meaningful amplitude rather than on every row.
        z0 = X[:, 2]
        zmax = float(np.abs(z0).max())
        big = z0[np.abs(z0) > 0.01 * zmax] if zmax > 1e-6 else np.array([])
        if big.size == 0:
            branch = None
        elif np.all(big > 0):
            branch = "N"
        elif np.all(big < 0):
            branch = "S"
        else:
            branch = "mixed"

        table = np.empty((X.shape[0], 9), dtype=np.float64)
        table[:, 0:6] = X
        table[:, 6] = energy
        table[:, 7] = period
        table[:, 8] = stability
        (OUT / f"{key}.f64").write_bytes(table.astype("<f8").tobytes())

        label, family, libr = LABELS.get(key, (key.replace("_", " "), None, None))
        manifest["families"].append(
            {
                "key": key,
                "label": label + (f" ({'north' if branch == 'N' else 'south'})" if branch in ("N", "S") else ""),
                "family": family,
                "libr": libr,
                "branch": branch,
                "count": int(X.shape[0]),
                "file": f"{key}.f64",
                "columns": ["x", "y", "z", "vx", "vy", "vz", "jacobi", "period", "stability"],
                "jacobiRange": [float(energy.min()), float(energy.max())],
                "periodRange": [float(period.min()), float(period.max())],
                "stabilityRange": [float(stability.min()), float(stability.max())],
                "jacobiCheck": err,
            }
        )
        print(
            f"  {key:14s} {X.shape[0]:6d} orbits  C [{energy.min():.5f}, {energy.max():.5f}]"
            f"  T [{period.min():.4f}, {period.max():.4f}]  branch {branch}"
        )

    (OUT / "index.json").write_text(json.dumps(manifest, indent=2))
    total = sum((OUT / f["file"]).stat().st_size for f in manifest["families"])
    print(f"\nwrote {OUT/'index.json'} ({len(manifest['families'])} families, {total/1024:.0f} KB)")
    if skipped:
        print(f"  skipped {len(skipped)}: {', '.join(skipped)}")


if __name__ == "__main__":
    main()
