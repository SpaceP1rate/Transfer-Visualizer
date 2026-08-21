import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Draggable bottom sheet for the compact layout.
 *
 * Three snap points: a peek that shows only the summary line, a half height for
 * working with the controls while still watching the scene, and full for the
 * delta-V surface. Dragging is restricted to the grip rather than the whole
 * sheet — a sheet you can drag from anywhere has to arbitrate between "the user
 * is scrolling the contents" and "the user is moving the sheet" on every touch,
 * and gets it wrong often enough to feel broken.
 */
const PEEK_FALLBACK = 92;
const SNAPS = ['full', 'half', 'peek'];

export default function BottomSheet({ summary, children }) {
  const sheetRef = useRef(null);
  const gripRef = useRef(null);
  const [height, setHeight] = useState(0);
  // The peek is measured, not assumed: a constant guess either clips the
  // summary or lets the panel below it bleed into view, and the grip's own
  // height changes with the text size and the safe-area inset.
  const [peek, setPeek] = useState(PEEK_FALLBACK);
  const [snap, setSnap] = useState('peek');
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    const el = sheetRef.current;
    const grip = gripRef.current;
    if (!el || !grip) return;
    const ro = new ResizeObserver(() => {
      setHeight(el.getBoundingClientRect().height);
      setPeek(Math.round(grip.getBoundingClientRect().height) || PEEK_FALLBACK);
    });
    ro.observe(el);
    ro.observe(grip);
    setHeight(el.getBoundingClientRect().height);
    setPeek(Math.round(grip.getBoundingClientRect().height) || PEEK_FALLBACK);
    return () => ro.disconnect();
  }, []);

  const offsetFor = useCallback(
    (s) => (s === 'full' ? 0 : s === 'half' ? Math.round(height * 0.52) : Math.max(0, height - peek)),
    [height, peek]
  );

  const offset = drag ? drag.offset : offsetFor(snap);

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ startY: e.clientY, startOffset: offsetFor(snap), offset: offsetFor(snap), moved: 0 });
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const next = Math.min(Math.max(drag.startOffset + dy, 0), Math.max(0, height - peek));
    setDrag({ ...drag, offset: next, moved: Math.max(drag.moved, Math.abs(dy)) });
  };

  const onPointerUp = () => {
    if (!drag) return;
    // A press that never moved is a tap: cycle between peek and half rather
    // than snapping back to where it started, which would look like nothing
    // happened.
    if (drag.moved < 6) {
      setSnap(snap === 'peek' ? 'half' : 'peek');
    } else {
      let best = SNAPS[0], bestD = Infinity;
      for (const s of SNAPS) {
        const d = Math.abs(offsetFor(s) - drag.offset);
        if (d < bestD) { bestD = d; best = s; }
      }
      setSnap(best);
    }
    setDrag(null);
  };

  return (
    <div
      ref={sheetRef}
      className={`sheet${drag ? ' dragging' : ''}`}
      style={{ transform: `translateY(${offset}px)` }}
    >
      <div
        ref={gripRef}
        className="sheet-grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="button"
        tabIndex={0}
        aria-label={snap === 'peek' ? 'Open controls' : 'Collapse controls'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setSnap(snap === 'peek' ? 'half' : 'peek');
        }}
      >
        <span className="sheet-bar" />
        <div className="sheet-summary">{summary}</div>
      </div>
      <div className="sheet-body">{children}</div>
    </div>
  );
}
