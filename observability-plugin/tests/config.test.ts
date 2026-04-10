import test from "node:test";
import assert from "node:assert/strict";

import { parseConfig } from "../src/config.ts";

test("parseConfig returns documented defaults for missing values", () => {
  const config = parseConfig(undefined);

  assert.deepEqual(config, {
    endpoint: "http://localhost:4318",
    protocol: "http",
    serviceName: "openclaw-gateway",
    headers: {},
    traces: true,
    metrics: true,
    logs: true,
    captureContent: false,
    metricsIntervalMs: 30_000,
    resourceAttributes: {},
  });
});

test("parseConfig preserves supported overrides and rejects invalid shapes", () => {
  const headers = { Authorization: "Bearer token" };
  const resourceAttributes = { "deployment.environment": "test" };

  const config = parseConfig({
    endpoint: "http://collector:4317",
    protocol: "grpc",
    serviceName: "integration-suite",
    headers,
    traces: false,
    metrics: false,
    logs: false,
    captureContent: true,
    metricsIntervalMs: 1500,
    resourceAttributes,
  });

  assert.equal(config.endpoint, "http://collector:4317");
  assert.equal(config.protocol, "grpc");
  assert.equal(config.serviceName, "integration-suite");
  assert.equal(config.headers, headers);
  assert.equal(config.traces, false);
  assert.equal(config.metrics, false);
  assert.equal(config.logs, false);
  assert.equal(config.captureContent, true);
  assert.equal(config.metricsIntervalMs, 1500);
  assert.equal(config.resourceAttributes, resourceAttributes);
});

test("parseConfig falls back when values are unsupported", () => {
  const config = parseConfig({
    endpoint: 42,
    protocol: "protobuf",
    serviceName: ["bad"],
    headers: ["bad"],
    traces: "yes",
    metrics: null,
    logs: 1,
    captureContent: "no",
    metricsIntervalMs: 999,
    resourceAttributes: [],
  });

  assert.equal(config.endpoint, "http://localhost:4318");
  assert.equal(config.protocol, "http");
  assert.equal(config.serviceName, "openclaw-gateway");
  assert.deepEqual(config.headers, {});
  assert.equal(config.traces, true);
  assert.equal(config.metrics, true);
  assert.equal(config.logs, true);
  assert.equal(config.captureContent, false);
  assert.equal(config.metricsIntervalMs, 30_000);
  assert.deepEqual(config.resourceAttributes, {});
});