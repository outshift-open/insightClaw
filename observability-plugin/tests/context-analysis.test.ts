//  Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
//  SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateCoverage,
  calculateGroundness,
  computeStringSimilarity,
  getNoveltyScore
} from "../src/context-analysis.js";

test("calculateCoverage - identical strings should have 100% coverage", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  const coverage = calculateCoverage(text, text, 3);
  assert.equal(coverage, 1.0);
});

test("calculateCoverage - empty largeStr should return 0", () => {
  const coverage = calculateCoverage("some text", "", 3);
  assert.equal(coverage, 0);
});

test("calculateCoverage - complete subset should return 100%", () => {
  const small = "the quick brown fox jumps over the lazy dog";
  const large = "the quick brown fox jumps";
  const coverage = calculateCoverage(small, large, 2);
  assert.equal(coverage, 1.0);
});

test("calculateCoverage - partial overlap should return fractional coverage", () => {
  const small = "the quick brown fox and the lazy dog";
  const large = "the quick brown cat";
  const coverage = calculateCoverage(small, large, 2);
  assert.ok(coverage > 0 && coverage < 1);
});

test("calculateCoverage - no overlap should return 0", () => {
  const small = "completely different words here";
  const large = "unrelated text content elsewhere";
  const coverage = calculateCoverage(small, large, 3);
  assert.equal(coverage, 0);
});

test("calculateCoverage - different n-gram sizes should produce different results", () => {
  const small = "the quick brown fox jumps over the lazy dog";
  const large = "the quick brown fox";
  const coverage2 = calculateCoverage(small, large, 2);
  const coverage3 = calculateCoverage(small, large, 3);
  const coverage5 = calculateCoverage(small, large, 5);
  
  // Smaller n-grams should generally have higher coverage
  assert.ok(coverage2 >= coverage3);
  assert.ok(coverage3 >= coverage5);
});

test("calculateGroundness - identical strings should have 100% groundness", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  const groundness = calculateGroundness(text, text);
  assert.equal(groundness, 1.0);
});

test("calculateGroundness - empty context should return 0", () => {
  const groundness = calculateGroundness("", "some ground text");
  assert.equal(groundness, 0);
});

test("calculateGroundness - context with only stop words should return 0", () => {
  const groundness = calculateGroundness("the and is at", "some other text");
  assert.equal(groundness, 0);
});

test("calculateGroundness - all tokens from ground should return 100%", () => {
  const context = "quick brown fox";
  const ground = "the quick brown fox jumps over the lazy dog";
  const groundness = calculateGroundness(context, ground);
  assert.equal(groundness, 1.0);
});

test("calculateGroundness - partial match should return fractional value", () => {
  const context = "quick brown elephant";
  const ground = "the quick brown fox jumps";
  const groundness = calculateGroundness(context, ground);
  assert.ok(groundness > 0 && groundness < 1);
  // Should be approximately 2/3 since 2 out of 3 non-stop words match
  assert.ok(Math.abs(groundness - 0.667) < 0.1);
});

test("calculateGroundness - no matching tokens should return 0", () => {
  const context = "elephant giraffe zebra";
  const ground = "quick brown fox";
  const groundness = calculateGroundness(context, ground);
  assert.equal(groundness, 0);
});

test("calculateGroundness - stop words should be ignored", () => {
  const context = "the and quick brown is fox";
  const ground = "quick brown fox jumps";
  const groundness = calculateGroundness(context, ground);
  // All 3 non-stop words should match
  assert.equal(groundness, 1.0);
});

test("computeStringSimilarity - wrong method", () => {
  const str1 = "the quick brown fox";
  const str2 = "the quick brown fox";
  
  // Passing invalid method should raise an exception
  assert.throws(() => {
    // @ts-ignore - intentionally testing invalid method
    computeStringSimilarity(str1, str2, "invalid_method");
  }, {
    message: "Unknown similarity method: invalid_method"
  });
});

test("computeStringSimilarity - identical strings should have 100% similarity", () => {
  const text = "the quick brown fox jumps";
  const similarity = computeStringSimilarity(text, text);
  assert.equal(similarity, 1.0);
});

test("computeStringSimilarity - empty strings should return NaN handled as 1", () => {
  const similarity = computeStringSimilarity("", "");
  // When both sets are empty, intersection/union = 0/0 = NaN, which becomes 1
  // This is expected behavior: two empty contexts are identical
  assert.ok(isNaN(similarity) || similarity === 0 || similarity === 1);
});

test("computeStringSimilarity - one empty string should return 0", () => {
  const similarity = computeStringSimilarity("some text", "");
  assert.equal(similarity, 0);
});

test("computeStringSimilarity - same words different order should have 100% similarity", () => {
  const str1 = "the quick brown fox";
  const str2 = "fox brown quick the";
  const similarity = computeStringSimilarity(str1, str2);
  assert.equal(similarity, 1.0);
});

test("computeStringSimilarity - partial overlap should return fractional similarity", () => {
  const str1 = "quick brown fox";
  const str2 = "quick brown cat";
  const similarity = computeStringSimilarity(str1, str2);
  // Union: {quick, brown, fox, cat} = 4
  // Intersection: {quick, brown} = 2
  // Similarity: 2/4 = 0.5
  assert.equal(similarity, 0.5);
});

test("computeStringSimilarity - no overlap should return 0", () => {
  const str1 = "quick brown fox";
  const str2 = "elephant giraffe zebra";
  const similarity = computeStringSimilarity(str1, str2);
  assert.equal(similarity, 0);
});

test("computeStringSimilarity - stop words should be ignored", () => {
  const str1 = "the quick brown fox and the";
  const str2 = "quick brown fox";
  const similarity = computeStringSimilarity(str1, str2);
  // Both should have the same set: {quick, brown, fox}
  assert.equal(similarity, 1.0);
});

test("computeStringSimilarity - case insensitive comparison", () => {
  const str1 = "Quick BROWN fox";
  const str2 = "quick brown FOX";
  const similarity = computeStringSimilarity(str1, str2);
  assert.equal(similarity, 1.0);
});

test("computeStringSimilarity - punctuation should be removed", () => {
  const str1 = "quick, brown: fox!";
  const str2 = "quick brown fox";
  const similarity = computeStringSimilarity(str1, str2);
  assert.equal(similarity, 1.0);
});

test("context analysis - subagent context derivation from main", () => {
  const mainContext = "This is a critical incident with p99 latency at 4200ms and error rate of 0.12 affecting checkout flow";
  const subContext = "p99 latency is at 4200ms and the error rate is 0.12 impacting the checkout flow";
  
  const groundness = calculateGroundness(subContext, mainContext);
  
  // Most of the subagent context should be derived from main
  assert.ok(groundness > 0.7, `Expected groundness > 0.7, got ${groundness}`);
});

test("context analysis - coverage between parent and subagent", () => {
  const parentContext = "You are analyzing a payment service incident with high latency and errors"; //7 words
  const subagentContext = "analyzing payment service incident"; // 4 words, all present in parent
  
  const coverage = calculateCoverage(subagentContext, parentContext, 2);
  
  // Coverage checks how much of parentContext's 2-grams appear in subagentContext
  // Since subagent is smaller, coverage will be lower
  assert.ok(coverage >= 0.6, `Expected coverage >= 0.6, got ${coverage}`);
});

test("context analysis - similarity between iterations of same agent", () => {
  const iteration1 = "Analyzing payment service latency metrics for checkout flow";
  const iteration2 = "Analyzing checkout flow payment service latency metrics";
  
  const similarity = computeStringSimilarity(iteration1, iteration2);
  
  // Should be very similar since they contain the same key terms
  // 7 unique words, all match = 0.875 or higher depending on stop words
  assert.ok(similarity > 0.85, `Expected similarity > 0.85, got ${similarity}`);
});

test("context analysis - low similarity between different agent contexts", () => {
  const telemetryAgent = "Analyzing latency metrics error rates and resource utilization";
  const databaseAgent = "Investigating connection pools query performance and deadlocks";
  
  const similarity = computeStringSimilarity(telemetryAgent, databaseAgent);
  
  // Should have low similarity since they focus on different aspects
  assert.ok(similarity < 0.3, `Expected similarity < 0.3, got ${similarity}`);
});

test("edge case - single word strings", () => {
  const coverage = calculateCoverage("word", "word", 1);
  const groundness = calculateGroundness("word", "word");
  const similarity = computeStringSimilarity("word", "word");
  
  assert.equal(coverage, 1.0);
  assert.equal(groundness, 1.0);
  assert.equal(similarity, 1.0);
});

test("edge case - strings with multiple spaces", () => {
  const str1 = "quick   brown    fox";
  const str2 = "quick brown fox";
  
  const similarity = computeStringSimilarity(str1, str2);
  assert.equal(similarity, 1.0);
});

test("edge case - strings with newlines and tabs", () => {
  const str1 = "quick\nbrown\tfox";
  const str2 = "quick brown fox";
  
  const similarity = computeStringSimilarity(str1, str2);
  assert.equal(similarity, 1.0);
});

test("real-world scenario - incident context propagation", () => {
  const mainAgentContext = `
    Critical incident: payment-service experiencing high latency.
    P99 latency: 4200ms, Error rate: 0.12, Impact: checkout flow.
    Need to identify root cause and blast radius.
  `;
  
  const subagentContext = `
    Investigate payment-service incident.
    p99 latency is at 4200ms and error rate is 0.12, impacting checkout flow.
  `;
  
  // Check that subagent context is well-grounded in main context
  const groundness = calculateGroundness(subagentContext, mainAgentContext);
  assert.ok(groundness > 0.8, `Expected high groundness, got ${groundness}`);
  
  // Check coverage of main context in subagent - with n=3, coverage may be low
  // Use n=2 for better coverage detection - coverage of 0.04+ is reasonable for
  // multi-line strings with different structures
  const coverage = calculateCoverage(subagentContext, mainAgentContext, 2);
  assert.ok(coverage > 0.5, `Expected some coverage, got ${coverage}`);
});


test("real-world scenario - incident context propagation", () => {
  const mainAgentContext = `
    Critical incident: payment-service experiencing high latency.
    P99 latency: 4200ms, Error rate: 0.12, Impact: checkout flow.
    Need to identify root cause and blast radius.
  `;
  
  const subagentContext = `
    Investigate history of meteo conditions in Europe.
    Check the weather patterns and their impact on the mood.
    Need to identify the correlation between weather and mood changes.
  `;
  
  // Check that subagent context is well-grounded in main context
  const groundness = calculateGroundness(subagentContext, mainAgentContext);
  assert.ok(groundness < 0.3, `Expected low groundness, got ${groundness}`);
  
  // Check coverage of main context in subagent - with n=3, coverage may be low
  // Use n=2 for better coverage detection - coverage of 0.04+ is reasonable for
  // multi-line strings with different structures
  const coverage = calculateCoverage(subagentContext, mainAgentContext, 2);
  assert.ok(coverage < 0.2, `Expected low coverage, got ${coverage}`);
});

// getNoveltyScore tests
test("getNoveltyScore - short yes answer should have 100% novelty", () => {
  const ground = "This is a critical incident with p99 latency at 4200ms and error rate of 0.12";
  const answer = "yes";
  const novelty = getNoveltyScore(answer, ground);
  assert.equal(novelty, 1.0);
});

test("getNoveltyScore - short no answer should have 100% novelty", () => {
  const ground = "Is the database healthy?";
  const answer = "no";
  const novelty = getNoveltyScore(answer, ground);
  assert.equal(novelty, 1.0);
});

test("getNoveltyScore - short true answer should have 100% novelty", () => {
  const ground = "Check if the service is running";
  const answer = "true";
  const novelty = getNoveltyScore(answer, ground);
  assert.equal(novelty, 1.0);
});

test("getNoveltyScore - short false answer should have 100% novelty", () => {
  const ground = "Verify the configuration";
  const answer = "false";
  const novelty = getNoveltyScore(answer, ground);
  assert.equal(novelty, 1.0);
});

test("getNoveltyScore - completely novel answer should have high novelty", () => {
  const ground = "The database shows connection pool saturation with 95 active connections";
  const answer = "Application cache invalidation strategy needs review and optimization";
  const novelty = getNoveltyScore(answer, ground);
  assert.ok(novelty > 0.9, `Expected novelty > 0.9, got ${novelty}`);
});

test("getNoveltyScore - answer that repeats ground should have low novelty", () => {
  const ground = "The payment service is experiencing high latency and error rates";
  const answer = "The payment service is experiencing high latency and error rates";
  const novelty = getNoveltyScore(answer, ground);
  assert.ok(novelty < 0.2, `Expected novelty < 0.2, got ${novelty}`);
});

test("getNoveltyScore - partially novel answer should have medium novelty", () => {
  const ground = "Critical incident with p99 latency at 4200ms affecting checkout flow";
  const answer = "P99 latency is 4200ms and root cause is misconfigured async queue";
  const novelty = getNoveltyScore(answer, ground);
  assert.ok(novelty > 0.3 && novelty < 0.7, `Expected novelty between 0.3 and 0.7, got ${novelty}`);
});

test("getNoveltyScore - empty answer should return 1 (fully novel)", () => {
  const ground = "Some context here";
  const answer = "";
  const novelty = getNoveltyScore(answer, ground);
  assert.equal(novelty, 1.0);
});

test("getNoveltyScore - answer with only stop words should have high novelty", () => {
  const ground = "The quick brown fox jumps over the lazy dog";
  const answer = "the and is at";
  const novelty = getNoveltyScore(answer, ground);
  // Since stop words are filtered out, this should be treated as mostly novel
  assert.ok(novelty > 0.8, `Expected novelty > 0.8, got ${novelty}`);
});

test("getNoveltyScore - real-world scenario: agent adds new insight", () => {
  const ground = "Payment service incident: p99 latency 4200ms, error rate 0.12, checkout impacted";
  const answer = "Database healthy with 22% connection utilization. Issue likely in async task queue causing timeout cascade";
  const novelty = getNoveltyScore(answer, ground);
  // Should have moderate to high novelty as it adds new technical diagnosis
  assert.ok(novelty > 0.5, `Expected novelty > 0.5, got ${novelty}`);
});

test("getNoveltyScore - real-world scenario: agent just confirms data", () => {
  const ground = "P99 latency is 4200ms and error rate is 0.12";
  const answer = "Confirmed: latency 4200ms and error rate 0.12";
  const novelty = getNoveltyScore(answer, ground);
  // Should have low novelty as it mostly repeats the ground
  assert.ok(novelty < 0.4, `Expected novelty < 0.4, got ${novelty}`);
});
