/**
 * D3 Graph bundle — esbuild entrypoint
 *
 * Bundled once via `npm run build:graph`, output committed as js/d3-bundle.js.
 * Imports only the d3 sub-modules needed by the graph page (plus dagre for
 * auto-layout) and exposes them as window.D3Graph for classic scripts.
 */

import { select, selectAll, pointer } from 'd3-selection';
import { zoom, zoomIdentity, zoomTransform } from 'd3-zoom';
import { path } from 'd3-path';
import { linkVertical, linkHorizontal, line, curveBasis, curveBumpY, curveBumpX } from 'd3-shape';
import { transition } from 'd3-transition';
import { interpolateNumber } from 'd3-interpolate';
import * as dagre from 'dagre';

export {
    select, selectAll, pointer,
    zoom, zoomIdentity, zoomTransform,
    path,
    linkVertical, linkHorizontal, line, curveBasis, curveBumpY, curveBumpX,
    transition,
    interpolateNumber,
    dagre,
};
