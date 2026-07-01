/**
 * OTel Browser SDK — esbuild entrypoint
 *
 * Bundled once via `npm run build:otel`, output committed as js/otel-bundle.js.
 * Exports a single init() function that sets up the WebTracerProvider and
 * exposes window.otelTracer / window.otelApi for classic scripts.
 */

import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
    W3CTraceContextPropagator,
    W3CBaggagePropagator,
    CompositePropagator,
} from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { propagation, context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

function init(exportUrl) {
    const resource = resourceFromAttributes({ 'service.name': 'acp-workforce-portal-browser' });

    const exporter = new OTLPTraceExporter({ url: exportUrl || '/workforce-portal/traces' });

    const provider = new WebTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(exporter, {
            maxQueueSize: 100,
            maxExportBatchSize: 10,
            scheduledDelayMillis: 2000,
        })],
    });

    // Composite propagator: traceparent AND baggage. Baggage carries end-user
    // (user.id) and session (session.id) identity from this first hop to every
    // backend span. The backend is already baggage-ready (Go sidecar composite
    // propagator + OTEL_PROPAGATORS=tracecontext,baggage on Node/Python); the
    // browser was the only hop dropping it.
    propagation.setGlobalPropagator(new CompositePropagator({
        propagators: [
            new W3CTraceContextPropagator(),
            new W3CBaggagePropagator(),
        ],
    }));
    provider.register();

    const tracer = trace.getTracer('workforce-portal', '1.0.0');

    // Expose globally for classic (non-module) scripts
    window.otelTracer = tracer;
    window.otelApi = { propagation, context, trace, SpanKind, SpanStatusCode };

    return tracer;
}

// esbuild --global-name=OtelBrowser wraps this module's exports into
// `var OtelBrowser = (() => { ... return { init }; })()` — making it a global.
export { init };
