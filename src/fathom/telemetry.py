"""Logs, traces and metrics. One tracer and one meter for the whole service."""

import logging

import structlog
from opentelemetry import metrics, trace

tracer = trace.get_tracer("fathom")
meter = metrics.get_meter("fathom")

searches = meter.create_counter("fathom.searches", description="Search requests, by mode")
search_duration = meter.create_histogram("fathom.search.duration", unit="s", description="Search wall time, by mode")
chunks_embedded = meter.create_counter("fathom.chunks.embedded", description="Chunks given a vector by the indexer")
embed_batch_duration = meter.create_histogram(
    "fathom.embed.batch.duration", unit="s", description="Wall time to embed and store one indexer batch"
)
documents_written = meter.create_counter("fathom.documents.written", description="Document upserts, by outcome")


def configure(level: str, otlp_endpoint: str | None) -> None:
    """JSON logs on stdout. Traces and metrics go out over OTLP only when an endpoint is configured."""
    logging.basicConfig(format="%(message)s", level=level.upper())
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelNamesMapping()[level.upper()]),
        cache_logger_on_first_use=True,
    )
    if otlp_endpoint is None:
        return
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter  # noqa: PLC0415
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter  # noqa: PLC0415
    from opentelemetry.sdk.metrics import MeterProvider  # noqa: PLC0415
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader  # noqa: PLC0415
    from opentelemetry.sdk.resources import Resource  # noqa: PLC0415
    from opentelemetry.sdk.trace import TracerProvider  # noqa: PLC0415
    from opentelemetry.sdk.trace.export import BatchSpanProcessor  # noqa: PLC0415

    resource = Resource.create({"service.name": "fathom"})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{otlp_endpoint}/v1/traces")))
    trace.set_tracer_provider(provider)
    reader = PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=f"{otlp_endpoint}/v1/metrics"))
    metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))
