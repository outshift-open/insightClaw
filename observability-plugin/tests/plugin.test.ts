import test from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.ts";
import manifest from "../openclaw.plugin.json";
import { register } from "node:module";

test("plugin metadata and config schema stay aligned with the public contract", () => {
  assert.equal(plugin.id, manifest.id);
  assert.equal(plugin.name, manifest.name);
  assert.equal(plugin.description, manifest.description);

  const config = plugin.configSchema.parse({
    protocol: "grpc",
    captureContent: true,
    spanCacheVerboseLogs: true,
    customAttributes: {
      "workspace-id": "UUID1",
    },
  });

  assert.equal(config.protocol, "grpc");
  assert.equal(config.captureContent, true);
  assert.equal(config.spanCacheVerboseLogs, true);
  assert.deepEqual(config.customAttributes, { "workspace-id": "UUID1" });
  assert.equal(config.endpoint, "http://localhost:4318");
});

test("plugin register wires the gateway method, cli command, tool, and service", async () => {
  const calls: Record<string, any[]> = {
    registerGatewayMethod: [],
    registerCli: [],
    registerService: [],
    registerTool: [],
  };

  const logger = {
    info() {},
    debug() {},
  };

  const api = {
    pluginConfig: {
      endpoint: "http://collector:4318",
      serviceName: "test-service",
      traces: false,
      metrics: true,
      logs: false,
      captureContent: true,
      spanCacheVerboseLogs: true,
      customAttributes: {
        "workspace-id": "UUID1",
        "mas-id": "UUID2",
      },
    },
    logger,
    registerGatewayMethod(name: string, handler: unknown) {
      calls.registerGatewayMethod.push({ name, handler });
    },
    registerCli(factory: unknown, options: unknown) {
      calls.registerCli.push({ factory, options });
    },
    registerService(service: unknown) {
      calls.registerService.push(service);
    },
    registerTool(tool: unknown, options: unknown) {
      calls.registerTool.push({ tool, options });
    },
    on() {},
    registerHook() {},
  };

  await plugin.register(api);

  assert.equal(calls.registerGatewayMethod.length, 1);
  assert.equal(calls.registerGatewayMethod[0]?.name, "insightclaw.status");
  assert.equal(calls.registerCli.length, 1);
  assert.deepEqual(calls.registerCli[0]?.options, { commands: ["otel"] });
  assert.equal(calls.registerService.length, 1);
  assert.equal(calls.registerTool.length, 1);


  const statusHandler = calls.registerGatewayMethod[0]?.handler as (arg: { respond: Function }) => void;
  let payload: any;
  statusHandler({
    respond(ok: boolean, response: unknown) {
      assert.equal(ok, true);
      payload = response;
    },
  });

  assert.deepEqual(payload, {
    initialized: false,
    config: {
      endpoint: "http://collector:4318",
      protocol: "http",
      serviceName: "test-service",
      traces: false,
      metrics: true,
      logs: false,
      captureContent: true,
      spanCache: false,
      spanCacheVerboseLogs: true,
      customAttributes: {
        "workspace-id": "UUID1",
        "mas-id": "UUID2",
      },
      experimentalMetrics: false,
      embeddingsProcessing: false,
    },
  });

  const toolRegistration = calls.registerTool[0];
  assert.equal(toolRegistration.options.optional, true);
  assert.equal(toolRegistration.tool.name, "otel_status");
});