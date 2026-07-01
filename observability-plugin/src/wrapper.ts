//  Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
//  SPDX-License-Identifier: Apache-2.0

// @ts-expect-error - openclaw/plugin-sdk types not available at build time
import type { OpenClawPluginApi, PluginHookName } from "openclaw/plugin-sdk/plugin-runtime";

// Marker to avoid double-wrapping after a registry replacement
const WRAPPED = Symbol.for("hook-observability.wrapped");

export async function wrapHooks(api: OpenClawPluginApi, opts?: {
  /** Called when a before_tool_call hook from another plugin returns { block: true }. */
  closeBlockedToolSpan?: (toolCallId: string, blockReason?: string) => void;
}) {
  let getGlobalPluginRegistry: (() => any) | undefined;
  try {
    // Dynamic import to avoid build issues if SDK not available
    // @ts-expect-error - openclaw/plugin-sdk types not available at build time
    const sdk = await import("openclaw/plugin-sdk/plugin-runtime") as any;
    getGlobalPluginRegistry = sdk.getGlobalPluginRegistry;
  } catch {
    // SDK not available — skip hook wrapping
    return;
  }

  const registry = getGlobalPluginRegistry?.();
  if (!registry) return;

  let wrapped = 0;
  for (const hook of registry.typedHooks) {
    if (hook.pluginId === api.id) continue;
    if (!isActionHook(hook.hookName)) continue; // observe-only hooks: no wrapping needed
    const current = hook.handler as ((...args: unknown[]) => unknown) & { [WRAPPED]?: true };
    if (!current || current[WRAPPED]) continue; // already wrapped

    const original = current;
    let wrapper: typeof hook.handler;
    if (SYNC_HOOKS.has(hook.hookName)) {
      const fn = ((event: unknown, ctx: unknown) => {
        try {
          const result = original(event, ctx);
          report({ hookName: hook.hookName, pluginId: hook.pluginId, priority: hook.priority ?? 0, event, ctx, result });
          if (hook.hookName === "before_tool_call" && (result as any)?.block === true) {
            const toolCallId = (event as any)?.toolCallId || (event as any)?.id || "";
            if (toolCallId) opts?.closeBlockedToolSpan?.(toolCallId, (result as any)?.blockReason);
          }
          return result;
        } catch (err) {
          report({ hookName: hook.hookName, pluginId: hook.pluginId, priority: hook.priority ?? 0, event, ctx, error: String(err) });
          throw err;
        }
      }) as typeof hook.handler & { [WRAPPED]?: true };
      (fn as any)[WRAPPED] = true;
      wrapper = fn;
    } else {
      const fn = (async (event: unknown, ctx: unknown) => {
        try {
          const result = await (original as (...args: unknown[]) => Promise<unknown>)(event, ctx);
          report({ hookName: hook.hookName, pluginId: hook.pluginId, priority: hook.priority ?? 0, event, ctx, result });
          if (hook.hookName === "before_tool_call" && (result as any)?.block === true) {
            const toolCallId = (event as any)?.toolCallId || (event as any)?.id || "";
            if (toolCallId) opts?.closeBlockedToolSpan?.(toolCallId, (result as any)?.blockReason);
          }
          return result;
        } catch (err) {
          report({ hookName: hook.hookName, pluginId: hook.pluginId, priority: hook.priority ?? 0, event, ctx, error: String(err) });
          throw err;
        }
      }) as typeof hook.handler & { [WRAPPED]?: true };
      (fn as any)[WRAPPED] = true;
      wrapper = fn;
    }
    hook.handler = wrapper;
    wrapped++;
  }

  if (wrapped > 0) {
    api.logger.info(`[hook-observability] wrapped ${wrapped} new hook handlers (total: ${registry.typedHooks.length})`);
    api.logger.info(registry.typedHooks.map((h: any) => `- ${h.pluginId} / ${h.hookName} (priority: ${h.priority ?? 0})${(h.handler as any)[WRAPPED] ? " [wrapped]" : ""}`).join("\n"));
  }
}

const SYNC_HOOKS = new Set<PluginHookName>(["tool_result_persist", "before_message_write"]);

/**
 * Hooks that are purely observational: their return value is ignored by the
 * runtime and they cannot alter the agent's behaviour.
 */
const OBSERVE_ONLY_HOOKS = new Set<PluginHookName>([
  "llm_input",
  "llm_output",
  "agent_end",
  "before_compaction",
  "after_compaction",
  "before_reset",
  "message_received",
  "message_sent",
  "after_tool_call",
  "session_start",
  "session_end",
  "subagent_spawned",
  "subagent_ended",
  "gateway_start",
  "gateway_stop",
]);

/**
 * Hooks whose return value is read by the runtime and can affect subsequent
 * processing (e.g. blocking a call, overriding a model, modifying a message).
 * Any hook NOT in OBSERVE_ONLY_HOOKS falls into this category.
 */
const isActionHook = (hookName: string): boolean =>
  !OBSERVE_ONLY_HOOKS.has(hookName as PluginHookName);

const report = (trace: { hookName: string; pluginId: string; priority: number; event: unknown; ctx: unknown; result?: unknown; error?: string }) => {
  // Hook into OTEL, a webhook, logs, etc.
  if (isActionHook(trace.hookName)) {
    // This hook can alter the agent's behaviour: trace the result
    // to detect overrides, blocks, etc.
    console.log("[hook-observability] ACTION hook trace:");
    console.log(JSON.stringify({ ...trace, category: "action" }));
  } else {
    // This hook is purely observational: its return value has no effect.
    console.log("[hook-observability] OBSERVE-ONLY hook trace:");
    console.log(JSON.stringify({ ...trace, category: "observe_only" }));
  }
};

