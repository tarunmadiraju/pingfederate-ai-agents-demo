'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { propagation } = require('@opentelemetry/api');

// Baggage keys copied 1:1 onto every span as same-named attributes. The browser
// seeds user.id (cleartext email) + session.id (AG-UI thread); the entry agent
// seeds origin_agent.id. Keys equal OTel semconv span-attribute names, so this
// is a straight copy with no translation table.
const BAGGAGE_TO_ATTR = ['user.id', 'session.id', 'origin_agent.id'];

// SpanProcessor that, on span start, copies request-scoped baggage onto the
// span as attributes. Stamps ALL spans (including auto-instrumented HTTP/MCP),
// so end-user/session/origin identity is queryable on every span in the trace.
class BaggageAttributeSpanProcessor {
  onStart(span, parentContext) {
    const bag = propagation.getBaggage(parentContext);
    if (!bag) return;
    for (const key of BAGGAGE_TO_ATTR) {
      const entry = bag.getEntry(key);
      if (entry && entry.value) span.setAttribute(key, entry.value);
    }
  }
  onEnd() {}
  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

// NOTE: when `spanProcessors` is supplied, NodeSDK IGNORES the `traceExporter`
// option — the array becomes the complete pipeline. So the OTLP export path must
// be added explicitly here (BatchSpanProcessor wrapping the exporter), alongside
// the baggage processor. Order: baggage stamps attributes onStart, then the
// batch processor exports the fully-stamped span.
const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
  spanProcessors: [
    new BaggageAttributeSpanProcessor(),
    new BatchSpanProcessor(new OTLPTraceExporter()),
  ],
});

sdk.start();
