# syntax=docker/dockerfile:1
FROM python:3.11-slim

WORKDIR /app

# Install dependencies (BuildKit cache keeps the pip cache across rebuilds).
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install .

# Copy source
COPY src/ ./src/

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health', timeout=3).status == 200 else 1)" || exit 1

# `opentelemetry-instrument` reads OTEL_* env vars from the ConfigMap
# (OTLP endpoint, service name, propagators, sampler) and auto-wires the
# tracer provider before our module loads. We still call
# HTTPXClientInstrumentor().instrument() manually inside server.py — the
# auto-instrumentor patches at import time, before our module loads, which
# is unreliable for httpx.
CMD ["opentelemetry-instrument", "python", "-m", "src.server"]
