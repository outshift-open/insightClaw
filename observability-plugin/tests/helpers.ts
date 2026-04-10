import type { Span, SpanContext, Attributes, Context } from "@opentelemetry/api";

export class MockCounter {
  public readonly calls: Array<{ value: number; attributes?: Attributes }> = [];

  add(value: number, attributes?: Attributes): void {
    this.calls.push({ value, attributes });
  }
}

export class MockHistogram {
  public readonly calls: Array<{ value: number; attributes?: Attributes }> = [];

  record(value: number, attributes?: Attributes): void {
    this.calls.push({ value, attributes });
  }
}

export class MockSpan {
  public readonly attributes = new Map<string, unknown>();
  public readonly statuses: Array<{ code: number; message?: string }> = [];
  public readonly events: Array<{ name: string; attributes?: Attributes }> = [];
  public ended = false;

  constructor(private readonly ctx: SpanContext) {}

  setAttribute(key: string, value: unknown): this {
    this.attributes.set(key, value);
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.statuses.push(status);
    return this;
  }

  addEvent(name: string, attributes?: Attributes): this {
    this.events.push({ name, attributes });
    return this;
  }

  end(): void {
    this.ended = true;
  }

  spanContext(): SpanContext {
    return this.ctx;
  }
}

export class MockTracer {
  public readonly spans: Array<{ name: string; options: any; context?: Context; span: MockSpan }> = [];
  private nextSpanId = 1;

  startSpan(name: string, options?: any, activeContext?: Context): Span {
    const span = new MockSpan({
      traceId: "1".repeat(32),
      spanId: this.nextSpanId.toString(16).padStart(16, "0"),
      traceFlags: 1,
    });
    this.nextSpanId += 1;
    this.spans.push({ name, options, context: activeContext, span });
    return span as unknown as Span;
  }
}

export function createSpanContext(spanId: string, traceId = "a".repeat(32)): SpanContext {
  return {
    traceId,
    spanId: spanId.padStart(16, "0").slice(-16),
    traceFlags: 1,
  };
}