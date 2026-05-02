import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { bootstrapOtel } from "@mindpal/shared";

bootstrapOtel({
  serviceName: "mindpal-worker",
  deps: { diag, DiagConsoleLogger, DiagLogLevel, OTLPTraceExporter, Resource, NodeSDK, SEMRESATTRS_SERVICE_NAME, getNodeAutoInstrumentations },
});
