// Loaded with `node --import` BEFORE the app so instrumentation can patch http/pg/fastify at require time.
// Opt-in: does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "amrutam-api" }),
    traceExporter: new OTLPTraceExporter(), // endpoint & headers come from the standard OTEL_EXPORTER_OTLP_* env vars
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
}
