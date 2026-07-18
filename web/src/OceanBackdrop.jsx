// The Ocean theme's backdrop — a thin React shell around the shared water sim (shared/oceanSim.js,
// the ONE copy of the sea, also inlined into the public /demo page by server/routes/demo.js).
// Everything interesting — the feedback-loop wave sim, the clock-following palette, the Fanad beam —
// lives there; this component just owns a canvas for it and unmounts cleanly.
import { useEffect, useRef } from 'react';
import { mountOcean, OCEAN_W, OCEAN_H } from '../../shared/oceanSim.js';

export default function OceanBackdrop() {
  const ref = useRef(null);

  useEffect(() => mountOcean(ref.current), []);

  return (
    <div className="ocean-bg" aria-hidden="true">
      <canvas ref={ref} width={OCEAN_W} height={OCEAN_H} />
    </div>
  );
}
