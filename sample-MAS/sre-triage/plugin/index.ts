// Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginRuntime,
} from "openclaw/plugin-sdk/plugin-entry";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SCRIPT_PATH = join(__dirname, "scripts", "change-scenario.sh");
const DEFAULT_RESET_SESSION_SCRIPT_PATH = join(__dirname, "scripts", "reset-session.sh");

function resolveScriptPath(pluginConfig: Record<string, unknown> | undefined): string {
  const configured = pluginConfig?.scriptPath;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_SCRIPT_PATH;
}

function resolveResetSessionScriptPath(pluginConfig: Record<string, unknown> | undefined): string {
  const configured = pluginConfig?.resetSessionScriptPath;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_RESET_SESSION_SCRIPT_PATH;
}

function createResetSessionCommand(
  pluginConfig: Record<string, unknown> | undefined,
  runtime: PluginRuntime,
): OpenClawPluginCommandDefinition {
  return {
    name: "reset_session",
    description: "Reset the current session",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      const scriptPath = resolveResetSessionScriptPath(pluginConfig);

      // Capture context fields needed for the completion callback.
      // `channel`   = surface name ("discord") — needed by loadAdapter
      // `channelId` = Discord channel snowflake   — needed as `to` by sendText
      // `to`        = "slash:…" interaction ref, not a plain snowflake
      const { config, channel, channelId, accountId } = ctx;
      console.log("[reset_session] channel:", channel, "channelId:", channelId);

      // The script calls back into the gateway (openclaw agent ...), so we must
      // NOT block the gateway waiting for it — that would deadlock. Launch it
      // detached and return immediately.
      const child = spawn(scriptPath, [], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      console.log("Script launched");
      // Send a follow-up message once the script exits.
      child.on("close", (code) => {
        void (async () => {
          try {
            console.log("[reset_session] close, code:", code, "channelId:", channelId);
            const adapter = await runtime.channel.outbound.loadAdapter(channel);
            console.log("[reset_session] adapter for", channel, ":", adapter);
            const text =
              code === 0
                ? "Session reset completed."
                : `Session reset failed (exit code ${code}).`;
            await adapter?.sendText({ cfg: config, to: `channel:${channelId!}`, accountId, text });
          } catch (err) {
            console.error("[reset_session] callback error:", err);
          }
        })();
      });

      return { text: "Session reset initiated." };
    },
  };
}

function createScenarioCommand(
  pluginConfig: Record<string, unknown> | undefined,
): OpenClawPluginCommandDefinition {
  return {
    name: "scenario",
    description: "Set up a scenario by number (e.g. /scenario 3)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      const raw = ctx.args?.trim() ?? "";

      // Validate that the argument is a non-negative integer.
      if (!/^\d+$/.test(raw)) {
        return {
          text: raw
            ? `Invalid scenario number: "${raw}". Usage: /scenario <integer>`
            : "Usage: /scenario <integer>",
        };
      }

      const scenarioNumber = raw;
      const scriptPath = resolveScriptPath(pluginConfig);

      const result = spawnSync(scriptPath, [scenarioNumber], {
        encoding: "utf-8",
        timeout: 30_000,
      });

      if (result.error) {
        return { text: `Failed to set up scenario ${scenarioNumber}: ${result.error.message}` };
      }

      const stdout = result.stdout?.trim() ?? "";
      const stderr = result.stderr?.trim() ?? "";
      const exitCode = result.status ?? -1;

      if (exitCode !== 0) {
        const detail = stderr || stdout || `exit code ${exitCode}`;
        return { text: `Setup for cenario ${scenarioNumber} failed: ${detail}` };
      }

      return { text: stdout || `Setup for Scenario ${scenarioNumber} completed.` };
    },
  };
}

export default definePluginEntry({
  id: "scenario",
  name: "Scenario",
  description: "Runs an external bash script with a scenario number.",
  register(api) {
    api.registerCommand(
      createScenarioCommand(api.pluginConfig),
    );
    api.registerCommand(
      createResetSessionCommand(api.pluginConfig, api.runtime),
    );
  },
});
