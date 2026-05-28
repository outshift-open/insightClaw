//  Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
//  SPDX-License-Identifier: Apache-2.0

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
    spanCache: false,
    spanCacheVerboseLogs: false,
    metricsIntervalMs: 30_000,
    resourceAttributes: {},
    customAttributes: {},
    experimentalMetrics: false,
    embeddingsProcessing: false,
  });
});

test("parseConfig preserves supported overrides and rejects invalid shapes", () => {
  const headers = { Authorization: "Bearer token" };
  const resourceAttributes = { "deployment.environment": "test" };
  const customAttributes = { "workspace-id": "UUID1", "mas-id": "UUID2", shard: 4, enabled: true };

  const config = parseConfig({
    endpoint: "http://collector:4317",
    protocol: "grpc",
    serviceName: "integration-suite",
    headers,
    traces: false,
    metrics: false,
    logs: false,
    captureContent: true,
    spanCache: true,
    spanCacheVerboseLogs: true,
    metricsIntervalMs: 1500,
    resourceAttributes,
    customAttributes,
    experimentalMetrics: false,
    embeddingsProcessing: false,
  });

  assert.equal(config.endpoint, "http://collector:4317");
  assert.equal(config.protocol, "grpc");
  assert.equal(config.serviceName, "integration-suite");
  assert.equal(config.headers, headers);
  assert.equal(config.traces, false);
  assert.equal(config.metrics, false);
  assert.equal(config.logs, false);
  assert.equal(config.captureContent, true);
  assert.equal(config.spanCache, true);
  assert.equal(config.spanCacheVerboseLogs, true);
  assert.equal(config.metricsIntervalMs, 1500);
  assert.equal(config.resourceAttributes, resourceAttributes);
  assert.deepEqual(config.customAttributes, customAttributes);
  assert.equal(config.experimentalMetrics, false);
  assert.equal(config.embeddingsProcessing, false);
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
    spanCache: "no",
    spanCacheVerboseLogs: "no",
    metricsIntervalMs: 999,
    resourceAttributes: [],
    customAttributes: { ok: "value", nested: { no: true } },
    experimentalMetrics: false,
    embeddingsProcessing: false,
  });

  assert.equal(config.endpoint, "http://localhost:4318");
  assert.equal(config.protocol, "http");
  assert.equal(config.serviceName, "openclaw-gateway");
  assert.deepEqual(config.headers, {});
  assert.equal(config.traces, true);
  assert.equal(config.metrics, true);
  assert.equal(config.logs, true);
  assert.equal(config.captureContent, false);
  assert.equal(config.spanCache, false);
  assert.equal(config.spanCacheVerboseLogs, false);
  assert.equal(config.metricsIntervalMs, 30_000);
  assert.deepEqual(config.resourceAttributes, {});
  assert.deepEqual(config.customAttributes, { ok: "value" });
  assert.equal(config.experimentalMetrics, false);
  assert.equal(config.embeddingsProcessing, false);
});