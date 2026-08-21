import { useEffect, useRef, useState } from 'react';

/**
 * Run an async producer and keep only the newest result.
 *
 * Propagation requests are fired by slider drags and selection changes, so
 * several are usually in flight; without a sequence guard a slow early request
 * can land after a fast later one and draw the wrong trajectory.
 */
export function useAsync(producer, deps, initial = null) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    let cancelled = false;
    // Clear first: holding the previous result while the new one is in flight
    // leaves stale geometry on screen after the selection changes.
    setValue(initial);
    const run = producer();
    if (!run) return;
    setPending(true);
    Promise.resolve(run)
      .then((v) => { if (!cancelled && mine === seq.current) setValue(v); })
      .catch(() => { if (!cancelled && mine === seq.current) setValue(null); })
      .finally(() => { if (!cancelled && mine === seq.current) setPending(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return [value, pending];
}

/** Flat XYZ buffer -> the array-of-triples drei's Line wants. */
export function toPoints(flat) {
  const out = new Array(flat.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]];
  return out;
}
