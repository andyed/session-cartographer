/**
 * SessionSizes — the same moment of a session at the sizes a rendering has to
 * survive: a sidebar tile, a list thumbnail and a 24 px glyph.
 *
 * Rows are the candidates. "Hub, scaled" is the control: the full-size hub
 * shrunk as a picture, which is what there was before it had levels of detail.
 * Every picture is an image, as on the map.
 */

import { useMemo } from 'react';
import { drawFlow } from '../../shared/flowmap/flow.js';
import { drawPortrait, portraitAspect, portraitState } from '../../shared/flowmap/portrait.js';
import { svgDataUri } from './session-map.js';

export const SIZES = [160, 64, 24];

export default function SessionSizes({ actions, at, speed, flow, layouts, drawOptions, hubSrc, names, reducedMotion }) {
  const motion = reducedMotion ? 'reduced' : 'full';
  const portrait = useMemo(() => portraitState(actions, at, { tau: 4000 * speed, travel: 900 * speed }), [actions, at, speed]);
  const aspect = layouts.ring.width / layouts.ring.height;
  const rows = [
    { name: 'Hub', aspect: () => aspect, src: size => svgDataUri(drawFlow(flow, { ...drawOptions, layout: layouts.ring, size, motion })) },
    { name: 'Board', aspect: () => aspect, src: size => svgDataUri(drawFlow(flow, { ...drawOptions, layout: layouts.board, size, motion })) },
    { name: 'Portrait', aspect: portraitAspect, src: size => svgDataUri(drawPortrait(portrait, { size, names, motion })) },
    { name: 'Hub, scaled', aspect: () => aspect, src: () => hubSrc },
  ];

  return (
    <section className="sm-sizes" aria-label="Sizes">
      <table className="sm-shrink">
        <thead>
          <tr>
            <th scope="col">Width</th>
            {SIZES.map(size => (
              <th key={size} scope="col">{size} px</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.name}>
              <th scope="row">{row.name}</th>
              {SIZES.map(size => (
                <td key={size}>
                  <img src={row.src(size)} alt="" draggable="false" style={{ width: size, aspectRatio: String(row.aspect(size)) }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
