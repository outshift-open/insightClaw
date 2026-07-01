/*
 * Copyright Traceloop
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

//  Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
//  SPDX-License-Identifier: Apache-2.0
//  Adapted from orginal work by Traceloop

'use strict';

var tslib = require('tslib');
var api = require('@opentelemetry/api');
var instrumentation = require('@opentelemetry/instrumentation');
var aiSemanticConventions = require('@traceloop/ai-semantic-conventions');
var instrumentationUtils = require('@traceloop/instrumentation-utils');
var incubating = require('@opentelemetry/semantic-conventions/incubating');
var jsTiktoken = require('js-tiktoken');

/**
 * OpenAI-specific message builders for OTel gen_ai attributes.
 *
 * OpenAI's API has a different structure from block-based providers:
 * - Input messages have typed content parts (user only), but system/developer/tool
 *   messages need special handling
 * - Response messages are flat (content is string, tool_calls/refusal/audio are separate fields)
 *
 * These builders convert OpenAI SDK shapes into OTel-shaped objects,
 * which are then serialized by the shared serializers in instrumentation-utils.
 */
// =============================================================================
// Finish reason mapping
// =============================================================================
/**
 * Maps OpenAI-specific finish reasons to OTel standard values.
 */
const openaiFinishReasonMap = {
    stop: aiSemanticConventions.FinishReasons.STOP,
    length: aiSemanticConventions.FinishReasons.LENGTH,
    tool_calls: aiSemanticConventions.FinishReasons.TOOL_CALL,
    content_filter: aiSemanticConventions.FinishReasons.CONTENT_FILTER,
    function_call: aiSemanticConventions.FinishReasons.TOOL_CALL, // deprecated but still exists
};
// =============================================================================
// Input message builder
// =============================================================================
/**
 * Converts OpenAI SDK request messages into OTel-shaped input messages.
 *
 * Per the OTel spec: "Instructions that are part of the chat history SHOULD be
 * recorded in gen_ai.input.messages attribute instead [of gen_ai.system_instructions]."
 *
 * OpenAI puts system/developer messages IN the chat history (messages array),
 * not as a separate parameter, so they stay in gen_ai.input.messages.
 *
 * @param messages - The messages array from the OpenAI chat completion request
 * @returns Array of OTel-shaped chat messages
 */
function buildOpenAIInputMessages(messages) {
    const inputMessages = [];
    for (const msg of messages) {
        switch (msg.role) {
            // -----------------------------------------------------------------
            // System / Developer — kept in input messages per OTel spec
            // (OpenAI puts these in the chat history, not as a separate param)
            // -----------------------------------------------------------------
            case "system":
            case "developer": {
                const parts = typeof msg.content === "string"
                    ? [{ type: "text", content: msg.content }]
                    : Array.isArray(msg.content)
                        ? msg.content.map(instrumentationUtils.mapOpenAIContentBlock)
                        : [];
                inputMessages.push({ role: msg.role, parts });
                break;
            }
            // -----------------------------------------------------------------
            // User → map content parts via mapOpenAIContentBlock
            // -----------------------------------------------------------------
            case "user": {
                const parts = typeof msg.content === "string"
                    ? [{ type: "text", content: msg.content }]
                    : Array.isArray(msg.content)
                        ? msg.content.map(instrumentationUtils.mapOpenAIContentBlock)
                        : [];
                inputMessages.push({ role: "user", parts });
                break;
            }
            // -----------------------------------------------------------------
            // Assistant → combine content + tool_calls into parts array
            // In multi-turn conversations, assistant messages may include
            // tool_calls that were previously returned by the model.
            // -----------------------------------------------------------------
            case "assistant": {
                const parts = [];
                // Text content
                if (typeof msg.content === "string" && msg.content) {
                    parts.push({ type: "text", content: msg.content });
                }
                else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        parts.push(instrumentationUtils.mapOpenAIContentBlock(block));
                    }
                }
                // Tool calls (from previous model response, sent back in multi-turn)
                if (Array.isArray(msg.tool_calls)) {
                    for (const tc of msg.tool_calls) {
                        if (tc.type === "function" && tc.function) {
                            parts.push({
                                type: "tool_call",
                                id: tc.id,
                                name: tc.function.name,
                                arguments: safeJsonParse(tc.function.arguments),
                            });
                        }
                        else if (tc.type === "custom" && tc.custom) {
                            parts.push({
                                type: "tool_call",
                                id: tc.id,
                                name: tc.custom.name,
                                arguments: tc.custom.input,
                            });
                        }
                    }
                }
                // Deprecated function_call
                if (msg.function_call) {
                    parts.push({
                        type: "tool_call",
                        name: msg.function_call.name,
                        arguments: safeJsonParse(msg.function_call.arguments),
                    });
                }
                inputMessages.push({ role: "assistant", parts });
                break;
            }
            // -----------------------------------------------------------------
            // Tool → wrap as tool_call_response with tool_call_id
            // -----------------------------------------------------------------
            case "tool": {
                const response = typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content);
                inputMessages.push({
                    role: "tool",
                    parts: [
                        {
                            type: "tool_call_response",
                            id: msg.tool_call_id,
                            response,
                        },
                    ],
                });
                break;
            }
            // -----------------------------------------------------------------
            // Deprecated function role
            // -----------------------------------------------------------------
            case "function": {
                inputMessages.push({
                    role: "tool",
                    parts: [
                        {
                            type: "tool_call_response",
                            id: msg.name,
                            response: msg.content,
                        },
                    ],
                });
                break;
            }
            // -----------------------------------------------------------------
            // Unknown role — pass through with text content
            // -----------------------------------------------------------------
            default: {
                const parts = typeof msg.content === "string"
                    ? [{ type: "text", content: msg.content }]
                    : Array.isArray(msg.content)
                        ? msg.content.map(instrumentationUtils.mapOpenAIContentBlock)
                        : [];
                inputMessages.push({ role: msg.role, parts });
                break;
            }
        }
    }
    return inputMessages;
}
// =============================================================================
// Output message builder
// =============================================================================
/**
 * Assembles an OTel output message from OpenAI's flat response fields.
 *
 * OpenAI's ChatCompletionMessage has:
 *   content: string | null        → TextPart
 *   refusal: string | null        → GenericPart {type: "refusal"}
 *   tool_calls: ToolCall[]        → ToolCallRequestPart[]
 *   audio: {data, transcript}     → BlobPart {modality: "audio"}
 *   function_call: {name, args}   → ToolCallRequestPart (deprecated)
 *
 * @param choice - A single ChatCompletion.Choice
 * @param finishReasonMap - Mapping of OpenAI finish reasons to OTel standard values
 * @returns Array with a single OTelOutputMessage
 */
function buildOpenAIOutputMessage(choice, finishReasonMap) {
    var _a, _b, _c;
    const parts = [];
    const message = choice.message;
    // Text content
    if (message.content) {
        parts.push({ type: "text", content: message.content });
    }
    // Safety refusal
    if (message.refusal) {
        parts.push({ type: "refusal", content: message.refusal });
    }
    // Tool calls
    if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            if (tc.type === "function" && tc.function) {
                parts.push({
                    type: "tool_call",
                    id: tc.id,
                    name: tc.function.name,
                    arguments: safeJsonParse(tc.function.arguments),
                });
            }
            else if (tc.type === "custom" && tc.custom) {
                parts.push({
                    type: "tool_call",
                    id: tc.id,
                    name: tc.custom.name,
                    arguments: tc.custom.input,
                });
            }
        }
    }
    // Deprecated function_call
    if (message.function_call) {
        parts.push({
            type: "tool_call",
            name: message.function_call.name,
            arguments: safeJsonParse(message.function_call.arguments),
        });
    }
    // Audio response
    if ((_a = message.audio) === null || _a === void 0 ? void 0 : _a.data) {
        parts.push({
            type: "blob",
            modality: "audio",
            mime_type: "audio/mp3",
            content: message.audio.data,
        });
    }
    return [
        {
            role: "assistant",
            finish_reason: (_c = (_b = finishReasonMap[choice.finish_reason]) !== null && _b !== void 0 ? _b : choice.finish_reason) !== null && _c !== void 0 ? _c : "stop",
            parts,
        },
    ];
}
/**
 * Assembles an OTel output message from an OpenAI text completion response.
 *
 * @param choice - A single Completion.Choice (has .text and .finish_reason)
 * @param finishReasonMap - Mapping of OpenAI finish reasons to OTel standard values
 * @returns Array with a single OTelOutputMessage
 */
function buildOpenAICompletionOutputMessage(choice, finishReasonMap) {
    var _a, _b, _c;
    const outputMsg = {
        role: "assistant",
        finish_reason: (_b = (_a = finishReasonMap[choice.finish_reason]) !== null && _a !== void 0 ? _a : choice.finish_reason) !== null && _b !== void 0 ? _b : "stop",
        parts: [{ type: "text", content: (_c = choice.text) !== null && _c !== void 0 ? _c : "" }],
    };
    return [outputMsg];
}
// =============================================================================
// Helpers
// =============================================================================
/**
 * Safely parse a JSON string, returning the original string if parsing fails.
 * OpenAI tool call arguments are JSON strings that should be parsed to objects.
 */
function safeJsonParse(value) {
    if (value === undefined)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch (_a) {
        return value;
    }
}

var version = "0.23.0";

/**
 * Calculate completion tokens for image generation based on OpenAI's actual token costs
 *
 * Token costs based on OpenAI documentation:
 * For gpt-image-1:     Square (1024×1024)    Portrait (1024×1536)    Landscape (1536×1024)
 * Low                  272 tokens            408 tokens              400 tokens
 * Medium               1056 tokens           1584 tokens             1568 tokens
 * High                 4160 tokens           6240 tokens             6208 tokens
 *
 * For DALL-E 3:
 * Standard             1056 tokens           1584 tokens             1568 tokens
 * HD                   4160 tokens           6240 tokens             6208 tokens
 */
function calculateImageGenerationTokens(params, imageCount) {
    var _a;
    const size = (params === null || params === void 0 ? void 0 : params.size) || "1024x1024";
    const model = (params === null || params === void 0 ? void 0 : params.model) || "dall-e-2";
    const quality = (params === null || params === void 0 ? void 0 : params.quality) || "standard";
    // Token costs for different models and sizes
    let tokensPerImage;
    if (model === "dall-e-2") {
        // DALL-E 2 has fixed costs regardless of quality
        const dalle2Costs = {
            "256x256": 68,
            "512x512": 272,
            "1024x1024": 1056,
        };
        tokensPerImage = dalle2Costs[size] || 1056;
    }
    else if (model === "dall-e-3") {
        // DALL-E 3 costs depend on quality and size
        const dalle3Costs = {
            standard: {
                "1024x1024": 1056,
                "1024x1792": 1584,
                "1792x1024": 1568,
            },
            hd: {
                "1024x1024": 4160,
                "1024x1792": 6240,
                "1792x1024": 6208,
            },
        };
        tokensPerImage =
            ((_a = dalle3Costs[quality]) === null || _a === void 0 ? void 0 : _a[size]) || dalle3Costs["standard"]["1024x1024"];
    }
    else {
        // Default fallback for unknown models
        tokensPerImage = 1056;
    }
    return tokensPerImage * imageCount;
}
function processImageInRequest(image_1, traceId_1, spanId_1, uploadCallback_1) {
    return tslib.__awaiter(this, arguments, void 0, function* (image, traceId, spanId, uploadCallback, index = 0) {
        try {
            let base64Data;
            let filename;
            if (typeof image === "string") {
                // Could be a file path, base64 string, or URL
                if (image.startsWith("data:image/")) {
                    const commaIndex = image.indexOf(",");
                    base64Data = image.substring(commaIndex + 1);
                    filename = `input_image_${index}.png`;
                }
                else if (image.startsWith("http")) {
                    return null;
                }
                else {
                    base64Data = image;
                    filename = `input_image_${index}.png`;
                }
            }
            else if (image && typeof image === "object") {
                // Handle Node.js Buffer objects and ReadStream
                if (Buffer.isBuffer(image)) {
                    base64Data = image.toString("base64");
                    filename = `input_image_${index}.png`;
                }
                else if (image.read && typeof image.read === "function") {
                    const chunks = [];
                    return new Promise((resolve) => {
                        image.on("data", (chunk) => chunks.push(chunk));
                        image.on("end", () => tslib.__awaiter(this, void 0, void 0, function* () {
                            try {
                                const buffer = Buffer.concat(chunks);
                                const base64Data = buffer.toString("base64");
                                const filename = image.path || `input_image_${index}.png`;
                                const url = yield uploadCallback(traceId, spanId, filename, base64Data);
                                resolve(url);
                            }
                            catch (error) {
                                console.error("Error processing stream image:", error);
                                resolve(null);
                            }
                        }));
                        image.on("error", (error) => {
                            console.error("Error reading image stream:", error);
                            resolve(null);
                        });
                    });
                }
                else {
                    return null;
                }
            }
            else {
                return null;
            }
            const url = yield uploadCallback(traceId, spanId, filename, base64Data);
            return url;
        }
        catch (error) {
            console.error("Error processing image in request:", error);
            return null;
        }
    });
}
function setImageGenerationRequestAttributes(span, params) {
    const attributes = {};
    if (params.model) {
        attributes[incubating.ATTR_GEN_AI_REQUEST_MODEL] = params.model;
    }
    if (params.size) {
        attributes["gen_ai.request.image.size"] = params.size;
    }
    if (params.quality) {
        attributes["gen_ai.request.image.quality"] = params.quality;
    }
    if (params.style) {
        attributes["gen_ai.request.image.style"] = params.style;
    }
    if (params.n) {
        attributes["gen_ai.request.image.count"] = params.n;
    }
    if (params.prompt) {
        attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES] = JSON.stringify([
            { role: "user", parts: [{ type: "text", content: params.prompt }] },
        ]);
    }
    Object.entries(attributes).forEach(([key, value]) => {
        if (value !== undefined) {
            span.setAttribute(key, value);
        }
    });
}
function setImageEditRequestAttributes(span, params, uploadCallback) {
    return tslib.__awaiter(this, void 0, void 0, function* () {
        const attributes = {};
        if (params.model) {
            attributes[incubating.ATTR_GEN_AI_REQUEST_MODEL] = params.model;
        }
        if (params.size) {
            attributes["gen_ai.request.image.size"] = params.size;
        }
        if (params.n) {
            attributes["gen_ai.request.image.count"] = params.n;
        }
        if (params.prompt) {
            attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES] = JSON.stringify([
                { role: "user", parts: [{ type: "text", content: params.prompt }] },
            ]);
        }
        // Process input image if upload callback is available
        if (params.image &&
            uploadCallback &&
            span.spanContext().traceId &&
            span.spanContext().spanId) {
            const traceId = span.spanContext().traceId;
            const spanId = span.spanContext().spanId;
            const imageUrl = yield processImageInRequest(params.image, traceId, spanId, uploadCallback, 0);
            if (imageUrl) {
                // Add the image as a part of the existing user message
                const existingMessages = attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES];
                if (existingMessages) {
                    const parsed = JSON.parse(existingMessages);
                    parsed[0].parts.push({
                        type: "uri",
                        modality: "image",
                        uri: imageUrl,
                    });
                    attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES] = JSON.stringify(parsed);
                }
                else {
                    attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES] = JSON.stringify([
                        {
                            role: "user",
                            parts: [{ type: "uri", modality: "image", uri: imageUrl }],
                        },
                    ]);
                }
            }
        }
        Object.entries(attributes).forEach(([key, value]) => {
            if (value !== undefined) {
                span.setAttribute(key, value);
            }
        });
    });
}
function setImageVariationRequestAttributes(span, params, uploadCallback) {
    return tslib.__awaiter(this, void 0, void 0, function* () {
        const attributes = {};
        if (params.model) {
            attributes[incubating.ATTR_GEN_AI_REQUEST_MODEL] = params.model;
        }
        if (params.size) {
            attributes["gen_ai.request.image.size"] = params.size;
        }
        if (params.n) {
            attributes["gen_ai.request.image.count"] = params.n;
        }
        // Process input image if upload callback is available
        if (params.image &&
            uploadCallback &&
            span.spanContext().traceId &&
            span.spanContext().spanId) {
            const traceId = span.spanContext().traceId;
            const spanId = span.spanContext().spanId;
            const imageUrl = yield processImageInRequest(params.image, traceId, spanId, uploadCallback, 0);
            if (imageUrl) {
                attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES] = JSON.stringify([
                    {
                        role: "user",
                        parts: [{ type: "uri", modality: "image", uri: imageUrl }],
                    },
                ]);
            }
        }
        Object.entries(attributes).forEach(([key, value]) => {
            if (value !== undefined) {
                span.setAttribute(key, value);
            }
        });
    });
}
function setImageGenerationResponseAttributes(span, response, uploadCallback, instrumentationConfig, params) {
    return tslib.__awaiter(this, void 0, void 0, function* () {
        const attributes = {};
        if (response.data && response.data.length > 0) {
            const completionTokens = calculateImageGenerationTokens(params, response.data.length);
            attributes[incubating.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS] = completionTokens;
            // Calculate prompt tokens if enrichTokens is enabled
            if (instrumentationConfig === null || instrumentationConfig === void 0 ? void 0 : instrumentationConfig.enrichTokens) {
                try {
                    let estimatedPromptTokens = 0;
                    if (params === null || params === void 0 ? void 0 : params.prompt) {
                        estimatedPromptTokens += Math.ceil(params.prompt.length / 4);
                    }
                    if (params === null || params === void 0 ? void 0 : params.image) {
                        estimatedPromptTokens += 272;
                    }
                    if (estimatedPromptTokens > 0) {
                        attributes[incubating.ATTR_GEN_AI_USAGE_INPUT_TOKENS] = estimatedPromptTokens;
                    }
                    attributes[aiSemanticConventions.SpanAttributes.GEN_AI_USAGE_TOTAL_TOKENS] =
                        estimatedPromptTokens + completionTokens;
                }
                catch (_a) {
                    attributes[aiSemanticConventions.SpanAttributes.GEN_AI_USAGE_TOTAL_TOKENS] = completionTokens;
                }
            }
            else {
                attributes[aiSemanticConventions.SpanAttributes.GEN_AI_USAGE_TOTAL_TOKENS] = completionTokens;
            }
        }
        if (response.data && response.data.length > 0) {
            const firstImage = response.data[0];
            let imageOutputUrl;
            if (firstImage.b64_json && uploadCallback) {
                try {
                    const traceId = span.spanContext().traceId;
                    const spanId = span.spanContext().spanId;
                    imageOutputUrl = yield uploadCallback(traceId, spanId, "generated_image.png", firstImage.b64_json);
                }
                catch (error) {
                    console.error("Failed to upload generated image:", error);
                }
            }
            else if (firstImage.url && uploadCallback) {
                try {
                    const traceId = span.spanContext().traceId;
                    const spanId = span.spanContext().spanId;
                    const response = yield fetch(firstImage.url);
                    const arrayBuffer = yield response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const base64Data = buffer.toString("base64");
                    imageOutputUrl = yield uploadCallback(traceId, spanId, "generated_image.png", base64Data);
                }
                catch (error) {
                    console.error("Failed to fetch and upload generated image:", error);
                    imageOutputUrl = firstImage.url;
                }
            }
            else if (firstImage.url) {
                imageOutputUrl = firstImage.url;
            }
            if (imageOutputUrl) {
                attributes[incubating.ATTR_GEN_AI_OUTPUT_MESSAGES] = JSON.stringify([
                    {
                        role: "assistant",
                        finish_reason: "stop",
                        parts: [{ type: "uri", modality: "image", uri: imageOutputUrl }],
                    },
                ]);
            }
            if (firstImage.revised_prompt) {
                attributes["gen_ai.response.revised_prompt"] = firstImage.revised_prompt;
            }
        }
        Object.entries(attributes).forEach(([key, value]) => {
            if (value !== undefined) {
                span.setAttribute(key, value);
            }
        });
    });
}
function wrapImageGeneration(tracer, uploadCallback, instrumentationConfig) {
    return function (original) {
        return function (...args) {
            const params = args[0];
            const span = tracer.startSpan(`image_generation ${params.model}`, {
                kind: api.SpanKind.CLIENT,
                attributes: {
                    [incubating.ATTR_GEN_AI_PROVIDER_NAME]: incubating.GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
                    [incubating.ATTR_GEN_AI_OPERATION_NAME]: "image_generation",
                    "gen_ai.request.type": "image_generation",
                },
            });
            const response = original.apply(this, args);
            if (response && typeof response.then === "function") {
                return response
                    .then((result) => tslib.__awaiter(this, void 0, void 0, function* () {
                    try {
                        setImageGenerationRequestAttributes(span, params);
                        yield setImageGenerationResponseAttributes(span, result, uploadCallback, instrumentationConfig, params);
                        return result;
                    }
                    catch (error) {
                        span.recordException(error);
                        throw error;
                    }
                    finally {
                        span.end();
                    }
                }))
                    .catch((error) => {
                    span.recordException(error);
                    span.end();
                    throw error;
                });
            }
            else {
                try {
                    setImageGenerationRequestAttributes(span, params);
                    return response;
                }
                catch (error) {
                    span.recordException(error);
                    throw error;
                }
                finally {
                    span.end();
                }
            }
        };
    };
}
function wrapImageEdit(tracer, uploadCallback, instrumentationConfig) {
    return function (original) {
        return function (...args) {
            const params = args[0];
            const span = tracer.startSpan(`image_edit ${params.model}`, {
                kind: api.SpanKind.CLIENT,
                attributes: {
                    [incubating.ATTR_GEN_AI_PROVIDER_NAME]: incubating.GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
                    [incubating.ATTR_GEN_AI_OPERATION_NAME]: "image_edit",
                    "gen_ai.request.type": "image_edit",
                },
            });
            const setRequestAttributesPromise = setImageEditRequestAttributes(span, params, uploadCallback).catch((error) => {
                console.error("Error setting image edit request attributes:", error);
            });
            const response = original.apply(this, args);
            if (response && typeof response.then === "function") {
                return response
                    .then((result) => tslib.__awaiter(this, void 0, void 0, function* () {
                    try {
                        yield setRequestAttributesPromise;
                        yield setImageGenerationResponseAttributes(span, result, uploadCallback, instrumentationConfig, params);
                        return result;
                    }
                    catch (error) {
                        span.recordException(error);
                        throw error;
                    }
                    finally {
                        span.end();
                    }
                }))
                    .catch((error) => tslib.__awaiter(this, void 0, void 0, function* () {
                    yield setRequestAttributesPromise;
                    span.recordException(error);
                    span.end();
                    throw error;
                }));
            }
            else {
                try {
                    return response;
                }
                catch (error) {
                    span.recordException(error);
                    throw error;
                }
                finally {
                    span.end();
                }
            }
        };
    };
}
function wrapImageVariation(tracer, uploadCallback, instrumentationConfig) {
    return function (original) {
        return function (...args) {
            const params = args[0];
            const span = tracer.startSpan(`image_variation ${params.model}`, {
                kind: api.SpanKind.CLIENT,
                attributes: {
                    [incubating.ATTR_GEN_AI_PROVIDER_NAME]: incubating.GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
                    [incubating.ATTR_GEN_AI_OPERATION_NAME]: "image_variation",
                    "gen_ai.request.type": "image_variation",
                },
            });
            const response = original.apply(this, args);
            if (response && typeof response.then === "function") {
                return response
                    .then((result) => tslib.__awaiter(this, void 0, void 0, function* () {
                    try {
                        yield setImageVariationRequestAttributes(span, params, uploadCallback);
                        yield setImageGenerationResponseAttributes(span, result, uploadCallback, instrumentationConfig, params);
                        return result;
                    }
                    catch (error) {
                        span.recordException(error);
                        throw error;
                    }
                    finally {
                        span.end();
                    }
                }))
                    .catch((error) => {
                    span.recordException(error);
                    span.end();
                    throw error;
                });
            }
            else {
                try {
                    return response;
                }
                catch (error) {
                    span.recordException(error);
                    throw error;
                }
                finally {
                    span.end();
                }
            }
        };
    };
}

class OpenAIInstrumentation extends instrumentation.InstrumentationBase {
    constructor(config = {}) {
        super("@traceloop/instrumentation-openai", version, config);
        this._encodingCache = new Map();
    }
    setConfig(config = {}) {
        super.setConfig(config);
    }
    manuallyInstrument(module) {
        this._diag.debug(`Manually instrumenting openai`);
        const openaiModule = module;
        this._wrap(openaiModule.Chat.Completions.prototype, "create", this.patchOpenAI(incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT));
        this._wrap(openaiModule.Completions.prototype, "create", this.patchOpenAI(incubating.GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION));
        if (openaiModule.Images) {
            this._wrap(openaiModule.Images.prototype, "generate", wrapImageGeneration(this.tracer, this._config.uploadBase64Image, this._config));
            this._wrap(openaiModule.Images.prototype, "edit", wrapImageEdit(this.tracer, this._config.uploadBase64Image, this._config));
            this._wrap(openaiModule.Images.prototype, "createVariation", wrapImageVariation(this.tracer, this._config.uploadBase64Image, this._config));
        }
    }
    init() {
        const module = new instrumentation.InstrumentationNodeModuleDefinition("openai", [">=4 <7"], this.patch.bind(this), this.unpatch.bind(this));
        return module;
    }
    patch(moduleExports, moduleVersion) {
        this._diag.debug(`Patching openai@${moduleVersion}`);
        // Old version of OpenAI API (v3.1.0)
        if (moduleExports.OpenAIApi) {
            this._wrap(moduleExports.OpenAIApi.prototype, "createChatCompletion", this.patchOpenAI(incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT, "v3"));
            this._wrap(moduleExports.OpenAIApi.prototype, "createCompletion", this.patchOpenAI(incubating.GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION, "v3"));
        }
        else {
            this._wrap(moduleExports.OpenAI.Chat.Completions.prototype, "create", this.patchOpenAI(incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT));
            this._wrap(moduleExports.OpenAI.Completions.prototype, "create", this.patchOpenAI(incubating.GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION));
            if (moduleExports.OpenAI.Images) {
                this._wrap(moduleExports.OpenAI.Images.prototype, "generate", wrapImageGeneration(this.tracer, this._config.uploadBase64Image, this._config));
                this._wrap(moduleExports.OpenAI.Images.prototype, "edit", wrapImageEdit(this.tracer, this._config.uploadBase64Image, this._config));
                this._wrap(moduleExports.OpenAI.Images.prototype, "createVariation", wrapImageVariation(this.tracer, this._config.uploadBase64Image, this._config));
            }
        }
        return moduleExports;
    }
    unpatch(moduleExports, moduleVersion) {
        this._diag.debug(`Unpatching openai@${moduleVersion}`);
        // Old version of OpenAI API (v3.1.0)
        if (moduleExports.OpenAIApi) {
            this._unwrap(moduleExports.OpenAIApi.prototype, "createChatCompletion");
            this._unwrap(moduleExports.OpenAIApi.prototype, "createCompletion");
        }
        else {
            this._unwrap(moduleExports.OpenAI.Chat.Completions.prototype, "create");
            this._unwrap(moduleExports.OpenAI.Completions.prototype, "create");
            if (moduleExports.OpenAI.Images) {
                this._unwrap(moduleExports.OpenAI.Images.prototype, "generate");
                this._unwrap(moduleExports.OpenAI.Images.prototype, "edit");
                this._unwrap(moduleExports.OpenAI.Images.prototype, "createVariation");
            }
        }
    }
    patchOpenAI(type, version = "v4") {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const plugin = this;
        // eslint-disable-next-line
        return (original) => {
            return function method(...args) {
                const span = type === incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT
                    ? plugin.startSpan({
                        type,
                        params: args[0],
                        client: this,
                    })
                    : plugin.startSpan({
                        type: incubating.GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
                        params: args[0],
                        client: this,
                    });
                const execContext = api.trace.setSpan(api.context.active(), span);
                const execPromise = instrumentation.safeExecuteInTheMiddle(() => {
                    return api.context.with(execContext, () => {
                        var _a;
                        if ((_a = args === null || args === void 0 ? void 0 : args[0]) === null || _a === void 0 ? void 0 : _a.extraAttributes) {
                            delete args[0].extraAttributes;
                        }
                        return original.apply(this, args);
                    });
                }, (e) => {
                    if (e) {
                        plugin._diag.error("OpenAI instrumentation: error", e);
                    }
                });
                if (args[0].stream) {
                    return api.context.bind(execContext, plugin._streamingWrapPromise({
                        span,
                        type,
                        params: args[0],
                        promise: execPromise,
                    }));
                }
                const wrappedPromise = plugin._wrapPromise(type, version, span, execPromise);
                return api.context.bind(execContext, wrappedPromise);
            };
        };
    }
    startSpan({ type, params, client, }) {
        var _a, _b, _c, _d;
        const { provider } = this._detectVendorFromURL(client);
        const attributes = {
            [incubating.ATTR_GEN_AI_PROVIDER_NAME]: provider,
            [incubating.ATTR_GEN_AI_OPERATION_NAME]: type,
        };
        try {
            attributes[incubating.ATTR_GEN_AI_REQUEST_MODEL] = params.model;
            if (params.max_tokens) {
                attributes[incubating.ATTR_GEN_AI_REQUEST_MAX_TOKENS] = params.max_tokens;
            }
            if (params.temperature) {
                attributes[incubating.ATTR_GEN_AI_REQUEST_TEMPERATURE] = params.temperature;
            }
            if (params.top_p) {
                attributes[incubating.ATTR_GEN_AI_REQUEST_TOP_P] = params.top_p;
            }
            if (params.frequency_penalty) {
                attributes[incubating.ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY] =
                    params.frequency_penalty;
            }
            if (params.presence_penalty) {
                attributes[incubating.ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY] =
                    params.presence_penalty;
            }
            if (params.extraAttributes !== undefined &&
                typeof params.extraAttributes === "object") {
                Object.keys(params.extraAttributes).forEach((key) => {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    attributes[key] = params.extraAttributes[key];
                });
            }
            if (this._shouldSendPrompts()) {
                if (type === incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT) {
                    // OpenAI puts system/developer messages in the chat history,
                    // not as a separate parameter. Per OTel spec, they stay in
                    // gen_ai.input.messages (not gen_ai.system_instructions).
                    const inputMessages = buildOpenAIInputMessages(params.messages);
                    attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES] =
                        JSON.stringify(inputMessages);
                    // Tool/function definitions as single JSON attribute (OTel 1.40)
                    // Spec: "The value of this attribute matches source system tool definition format."
                    const toolDefs = [];
                    // Legacy functions API — bare {name, description, parameters} IS the source format
                    (_a = params.functions) === null || _a === void 0 ? void 0 : _a.forEach((func) => {
                        toolDefs.push(func);
                    });
                    // Tools API — preserve full {type, function: {...}} wrapper (source format)
                    (_b = params.tools) === null || _b === void 0 ? void 0 : _b.forEach((tool) => {
                        toolDefs.push(tool);
                    });
                    if (toolDefs.length > 0) {
                        attributes[incubating.ATTR_GEN_AI_TOOL_DEFINITIONS] = JSON.stringify(toolDefs);
                    }
                }
                else {
                    attributes[incubating.ATTR_GEN_AI_INPUT_MESSAGES] =
                        instrumentationUtils.formatInputMessagesFromPrompt(typeof params.prompt === "string"
                            ? params.prompt
                            : JSON.stringify(params.prompt));
                }
            }
        }
        catch (e) {
            this._diag.debug(e);
            (_d = (_c = this._config).exceptionLogger) === null || _d === void 0 ? void 0 : _d.call(_c, e);
        }
        return this.tracer.startSpan(`${type} ${params === null || params === void 0 ? void 0 : params.model}`, {
            kind: api.SpanKind.CLIENT,
            attributes,
        });
    }
    _streamingWrapPromise(_a) {
        return tslib.__asyncGenerator(this, arguments, function* _streamingWrapPromise_1({ span, type, params, promise, }) {
            var _b, e_1, _c, _d, _e, e_2, _f, _g;
            var _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8;
            if (type === incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT) {
                const result = {
                    id: "0",
                    created: -1,
                    model: "",
                    choices: [
                        {
                            index: 0,
                            logprobs: null,
                            finish_reason: null,
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [],
                            },
                        },
                    ],
                    object: "chat.completion",
                };
                try {
                    for (var _9 = true, _10 = tslib.__asyncValues(yield tslib.__await(promise)), _11; _11 = yield tslib.__await(_10.next()), _b = _11.done, !_b; _9 = true) {
                        _d = _11.value;
                        _9 = false;
                        const chunk = _d;
                        yield yield tslib.__await(chunk);
                        result.id = chunk.id;
                        result.created = chunk.created;
                        result.model = chunk.model;
                        if ((_h = chunk.choices[0]) === null || _h === void 0 ? void 0 : _h.finish_reason) {
                            result.choices[0].finish_reason = chunk.choices[0].finish_reason;
                        }
                        if ((_j = chunk.choices[0]) === null || _j === void 0 ? void 0 : _j.logprobs) {
                            result.choices[0].logprobs = chunk.choices[0].logprobs;
                        }
                        if ((_k = chunk.choices[0]) === null || _k === void 0 ? void 0 : _k.delta.content) {
                            result.choices[0].message.content += chunk.choices[0].delta.content;
                        }
                        if (((_l = chunk.choices[0]) === null || _l === void 0 ? void 0 : _l.delta.function_call) &&
                            ((_m = chunk.choices[0]) === null || _m === void 0 ? void 0 : _m.delta.function_call.arguments) &&
                            ((_o = chunk.choices[0]) === null || _o === void 0 ? void 0 : _o.delta.function_call.name)) {
                            // I needed to re-build the object so that Typescript will understand that `name` and `argument` are not null.
                            result.choices[0].message.function_call = {
                                name: chunk.choices[0].delta.function_call.name,
                                arguments: chunk.choices[0].delta.function_call.arguments,
                            };
                        }
                        if (chunk.usage) {
                            result.usage = chunk.usage;
                        }
                        for (const toolCall of (_r = (_q = (_p = chunk.choices[0]) === null || _p === void 0 ? void 0 : _p.delta) === null || _q === void 0 ? void 0 : _q.tool_calls) !== null && _r !== void 0 ? _r : []) {
                            if (((_t = (_s = result.choices[0].message.tool_calls) === null || _s === void 0 ? void 0 : _s.length) !== null && _t !== void 0 ? _t : 0) <
                                toolCall.index + 1) {
                                (_u = result.choices[0].message.tool_calls) === null || _u === void 0 ? void 0 : _u.push({
                                    function: {
                                        name: "",
                                        arguments: "",
                                    },
                                    id: "",
                                    type: "function",
                                });
                            }
                            if (result.choices[0].message.tool_calls) {
                                if (toolCall.id) {
                                    result.choices[0].message.tool_calls[toolCall.index].id +=
                                        toolCall.id;
                                }
                                if (toolCall.type) {
                                    result.choices[0].message.tool_calls[toolCall.index].type =
                                        toolCall.type;
                                }
                                if ((_v = toolCall.function) === null || _v === void 0 ? void 0 : _v.name) {
                                    result.choices[0].message.tool_calls[toolCall.index].function.name += toolCall.function.name;
                                }
                                if ((_w = toolCall.function) === null || _w === void 0 ? void 0 : _w.arguments) {
                                    result.choices[0].message.tool_calls[toolCall.index].function.arguments += toolCall.function.arguments;
                                }
                            }
                        }
                    }
                }
                catch (e_1_1) { e_1 = { error: e_1_1 }; }
                finally {
                    try {
                        if (!_9 && !_b && (_c = _10.return)) yield tslib.__await(_c.call(_10));
                    }
                    finally { if (e_1) throw e_1.error; }
                }
                if ((_x = result.choices[0].logprobs) === null || _x === void 0 ? void 0 : _x.content) {
                    this._addLogProbsEvent(span, result.choices[0].logprobs);
                }
                if ((result.usage === undefined) && (this._config.enrichTokens)) {
                    let promptTokens = 0;
                    for (const message of params.messages) {
                        promptTokens +=
                            (_y = this.tokenCountFromString(message.content, result.model)) !== null && _y !== void 0 ? _y : 0;
                    }
                    const completionTokens = this.tokenCountFromString((_z = result.choices[0].message.content) !== null && _z !== void 0 ? _z : "", result.model);
                    if (completionTokens) {
                        result.usage = {
                            prompt_tokens: promptTokens,
                            completion_tokens: completionTokens,
                            total_tokens: promptTokens + completionTokens,
                        };
                    }
                }
                this._endSpan({ span, type, result });
            }
            else {
                const result = {
                    id: "0",
                    created: -1,
                    model: "",
                    choices: [
                        {
                            index: 0,
                            logprobs: null,
                            finish_reason: null,
                            text: "",
                        },
                    ],
                    object: "text_completion",
                };
                try {
                    for (var _12 = true, _13 = tslib.__asyncValues(yield tslib.__await(promise)), _14; _14 = yield tslib.__await(_13.next()), _e = _14.done, !_e; _12 = true) {
                        _g = _14.value;
                        _12 = false;
                        const chunk = _g;
                        yield yield tslib.__await(chunk);
                        try {
                            result.id = chunk.id;
                            result.created = chunk.created;
                            result.model = chunk.model;
                            if ((_0 = chunk.choices[0]) === null || _0 === void 0 ? void 0 : _0.finish_reason) {
                                result.choices[0].finish_reason = chunk.choices[0].finish_reason;
                            }
                            if ((_1 = chunk.choices[0]) === null || _1 === void 0 ? void 0 : _1.logprobs) {
                                result.choices[0].logprobs = chunk.choices[0].logprobs;
                            }
                            if ((_2 = chunk.choices[0]) === null || _2 === void 0 ? void 0 : _2.text) {
                                result.choices[0].text += chunk.choices[0].text;
                            }
                        }
                        catch (e) {
                            this._diag.debug(e);
                            (_4 = (_3 = this._config).exceptionLogger) === null || _4 === void 0 ? void 0 : _4.call(_3, e);
                        }
                    }
                }
                catch (e_2_1) { e_2 = { error: e_2_1 }; }
                finally {
                    try {
                        if (!_12 && !_e && (_f = _13.return)) yield tslib.__await(_f.call(_13));
                    }
                    finally { if (e_2) throw e_2.error; }
                }
                try {
                    if (result.choices[0].logprobs) {
                        this._addLogProbsEvent(span, result.choices[0].logprobs);
                    }
                    if (this._config.enrichTokens) {
                        const promptTokens = (_5 = this.tokenCountFromString(params.prompt, result.model)) !== null && _5 !== void 0 ? _5 : 0;
                        const completionTokens = this.tokenCountFromString((_6 = result.choices[0].text) !== null && _6 !== void 0 ? _6 : "", result.model);
                        if (completionTokens) {
                            result.usage = {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionTokens,
                                total_tokens: promptTokens + completionTokens,
                            };
                        }
                    }
                }
                catch (e) {
                    this._diag.debug(e);
                    (_8 = (_7 = this._config).exceptionLogger) === null || _8 === void 0 ? void 0 : _8.call(_7, e);
                }
                this._endSpan({ span, type, result });
            }
        });
    }
    _wrapPromise(type, version, span, promise) {
        return promise._thenUnwrap((result) => {
            if (version === "v3") {
                if (type === incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT) {
                    this._addLogProbsEvent(span, result.data.choices[0].logprobs);
                    this._endSpan({
                        type,
                        span,
                        result: result.data,
                    });
                }
                else {
                    this._addLogProbsEvent(span, result.data.choices[0].logprobs);
                    this._endSpan({
                        type,
                        span,
                        result: result.data,
                    });
                }
            }
            else {
                if (type === incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT) {
                    this._addLogProbsEvent(span, result.choices[0].logprobs);
                    this._endSpan({ type, span, result: result });
                }
                else {
                    this._addLogProbsEvent(span, result.choices[0].logprobs);
                    this._endSpan({ type, span, result: result });
                }
            }
            return result;
        });
    }
    _endSpan({ span, type, result, }) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        try {
            span.setAttribute(incubating.ATTR_GEN_AI_RESPONSE_MODEL, result.model);
            if (result.id) {
                span.setAttribute(incubating.ATTR_GEN_AI_RESPONSE_ID, result.id);
            }
            if (result.usage) {
                span.setAttribute(aiSemanticConventions.SpanAttributes.GEN_AI_USAGE_TOTAL_TOKENS, (_a = result.usage) === null || _a === void 0 ? void 0 : _a.total_tokens);
                span.setAttribute(incubating.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, (_b = result.usage) === null || _b === void 0 ? void 0 : _b.completion_tokens);
                span.setAttribute(incubating.ATTR_GEN_AI_USAGE_INPUT_TOKENS, (_c = result.usage) === null || _c === void 0 ? void 0 : _c.prompt_tokens);
            }
            if (type === incubating.GEN_AI_OPERATION_NAME_VALUE_CHAT) {
                // Set finish reasons (always — it's metadata, not user content)
                const finishReason = (_d = result.choices[0]) === null || _d === void 0 ? void 0 : _d.finish_reason;
                const mappedReason = (_f = (_e = openaiFinishReasonMap[finishReason]) !== null && _e !== void 0 ? _e : finishReason) !== null && _f !== void 0 ? _f : "stop";
                span.setAttribute(incubating.ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [mappedReason]);
                if (this._shouldSendPrompts()) {
                    const outputMessages = buildOpenAIOutputMessage(result.choices[0], openaiFinishReasonMap);
                    span.setAttribute(incubating.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify(outputMessages));
                }
            }
            else {
                // Text completion
                const finishReason = (_g = result.choices[0]) === null || _g === void 0 ? void 0 : _g.finish_reason;
                const mappedReason = (_j = (_h = openaiFinishReasonMap[finishReason]) !== null && _h !== void 0 ? _h : finishReason) !== null && _j !== void 0 ? _j : "stop";
                span.setAttribute(incubating.ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [mappedReason]);
                if (this._shouldSendPrompts()) {
                    const outputMessages = buildOpenAICompletionOutputMessage(result.choices[0], openaiFinishReasonMap);
                    span.setAttribute(incubating.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify(outputMessages));
                }
            }
        }
        catch (e) {
            this._diag.debug(e);
            (_l = (_k = this._config).exceptionLogger) === null || _l === void 0 ? void 0 : _l.call(_k, e);
        }
        span.end();
    }
    _shouldSendPrompts() {
        const contextShouldSendPrompts = api.context
            .active()
            .getValue(aiSemanticConventions.CONTEXT_KEY_ALLOW_TRACE_CONTENT);
        if (contextShouldSendPrompts !== undefined) {
            return contextShouldSendPrompts;
        }
        return this._config.traceContent !== undefined
            ? this._config.traceContent
            : true;
    }
    _addLogProbsEvent(span, logprobs) {
        var _a, _b;
        try {
            let result = [];
            if (!logprobs) {
                return;
            }
            const chatLogprobs = logprobs;
            const completionLogprobs = logprobs;
            if (chatLogprobs.content) {
                result = chatLogprobs.content.map((logprob) => {
                    return {
                        token: logprob.token,
                        logprob: logprob.logprob,
                    };
                });
            }
            else if ((completionLogprobs === null || completionLogprobs === void 0 ? void 0 : completionLogprobs.tokens) &&
                (completionLogprobs === null || completionLogprobs === void 0 ? void 0 : completionLogprobs.token_logprobs)) {
                completionLogprobs.tokens.forEach((token, index) => {
                    var _a;
                    const logprob = (_a = completionLogprobs.token_logprobs) === null || _a === void 0 ? void 0 : _a[index];
                    if (logprob) {
                        result.push({
                            token,
                            logprob,
                        });
                    }
                });
            }
            span.addEvent("logprobs", { logprobs: JSON.stringify(result) });
        }
        catch (e) {
            this._diag.debug(e);
            (_b = (_a = this._config).exceptionLogger) === null || _b === void 0 ? void 0 : _b.call(_a, e);
        }
    }
    tokenCountFromString(text, model) {
        var _a, _b;
        if (!text) {
            return 0;
        }
        let encoding = this._encodingCache.get(model);
        if (!encoding) {
            try {
                encoding = jsTiktoken.encodingForModel(model);
                this._encodingCache.set(model, encoding);
            }
            catch (e) {
                this._diag.debug(e);
                (_b = (_a = this._config).exceptionLogger) === null || _b === void 0 ? void 0 : _b.call(_a, e);
                return 0;
            }
        }
        return encoding.encode(text).length;
    }
    _detectVendorFromURL(client) {
        try {
            if (!(client === null || client === void 0 ? void 0 : client.baseURL)) {
                return { provider: incubating.GEN_AI_PROVIDER_NAME_VALUE_OPENAI };
            }
            const baseURL = client.baseURL.toLowerCase();
            if (baseURL.includes("azure") || baseURL.includes("openai.azure.com")) {
                return { provider: incubating.GEN_AI_PROVIDER_NAME_VALUE_AZURE_AI_OPENAI };
            }
            if (baseURL.includes("openai.com") ||
                baseURL.includes("api.openai.com")) {
                return { provider: incubating.GEN_AI_PROVIDER_NAME_VALUE_OPENAI };
            }
            if (baseURL.includes("amazonaws.com") || baseURL.includes("bedrock")) {
                return { provider: incubating.GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK };
            }
            if (baseURL.includes("aiplatform.googleapis.com")) {
                return { provider: incubating.GEN_AI_PROVIDER_NAME_VALUE_GCP_VERTEX_AI };
            }
            if (baseURL.includes("generativelanguage.googleapis.com")) {
                return { provider: "gcp.gemini" };
            }
            if (baseURL.includes("googleapis.com")) {
                return { provider: "gcp.gen_ai" }; // fallback for other Google APIs
            }
            if (baseURL.includes("openrouter")) {
                return { provider: "openrouter" };
            }
            return { provider: incubating.GEN_AI_PROVIDER_NAME_VALUE_OPENAI };
        }
        catch (e) {
            this._diag.debug(`Failed to detect vendor from URL: ${e}`);
            return { provider: incubating.GEN_AI_PROVIDER_NAME_VALUE_OPENAI };
        }
    }
}

exports.OpenAIInstrumentation = OpenAIInstrumentation;
//# sourceMappingURL=index.js.map
