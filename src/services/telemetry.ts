import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { DeploymentVersionService } from "./deployment-version-service";
import {
  type TelemetryEventRecord,
  type TelemetryKnownFields,
  type TelemetryOutcome,
  type TelemetrySeverity,
  type TelemetrySpanRecord,
  TelemetryStore,
} from "./telemetry-store";

type TelemetryAttributes = Record<string, unknown>;

export type TelemetryRunContext = TelemetryKnownFields & {
  traceId?: string;
  component?: string;
  attributes?: TelemetryAttributes;
};

type ActiveSpan = TelemetryKnownFields & {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  component: string;
  operation: string;
  startedAt: string;
  startedNs: bigint;
  attributes: TelemetryAttributes;
};

type TelemetryScope = {
  traceId: string;
  component: string;
  defaults: TelemetryAttributes;
  known: TelemetryKnownFields;
  spans: ActiveSpan[];
};

type TelemetryChildOptions = TelemetryKnownFields & {
  component: string;
  defaults?: TelemetryAttributes;
};

type TelemetryEventOptions = {
  level?: TelemetrySeverity;
  message?: string;
  outcome?: TelemetryOutcome;
};

type InstrumentedFetchParams = TelemetryKnownFields & {
  component?: string;
  operation?: string;
  method?: string;
  url: string;
  init?: RequestInit;
};

type InstrumentedSpawnParams = TelemetryKnownFields & {
  component?: string;
  operation?: string;
  command: string;
  args: string[];
  options?: SpawnOptionsWithoutStdio;
  timeoutMs?: number;
  input?: string;
};

type InstrumentedActionParams = TelemetryKnownFields & {
  component?: string;
  operation: string;
  attributes?: TelemetryAttributes;
};

type InstrumentMethodsOptions = TelemetryKnownFields & {
  component?: string;
  operationPrefix?: string;
  include?: string[];
  exclude?: string[];
  attributeFactory?: (params: {
    methodName: string;
    args: unknown[];
    className: string;
  }) => TelemetryAttributes | undefined;
};

const SERVICE_NAME = "openelinaro";
const AUTO_INSTRUMENTED_TARGETS = new WeakMap<object, object>();

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes: number) {
  return crypto.randomBytes(bytes).toString("hex");
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function splitOperation(name: string) {
  const trimmed = name.trim();
  const firstDot = trimmed.indexOf(".");
  if (firstDot <= 0 || firstDot === trimmed.length - 1) {
    return {
      component: "app",
      operation: trimmed || "unknown",
    };
  }
  return {
    component: trimmed.slice(0, firstDot),
    operation: trimmed.slice(firstDot + 1),
  };
}

function extractKnownFields(attributes: TelemetryAttributes): TelemetryKnownFields {
  return {
    conversationKey:
      typeof attributes.conversationKey === "string" ? attributes.conversationKey : undefined,
    workflowRunId:
      typeof attributes.workflowRunId === "string" ? attributes.workflowRunId : undefined,
    taskId: typeof attributes.taskId === "string" ? attributes.taskId : undefined,
    toolName: typeof attributes.toolName === "string" ? attributes.toolName : undefined,
    profileId: typeof attributes.profileId === "string" ? attributes.profileId : undefined,
    provider: typeof attributes.provider === "string" ? attributes.provider : undefined,
    jobId: typeof attributes.jobId === "string" ? attributes.jobId : undefined,
    entityType: typeof attributes.entityType === "string" ? attributes.entityType : undefined,
    entityId: typeof attributes.entityId === "string" ? attributes.entityId : undefined,
  };
}

function mergeKnownFields(...values: Array<TelemetryKnownFields | undefined>) {
  return values.reduce<TelemetryKnownFields>((merged, entry) => ({
    conversationKey: entry?.conversationKey ?? merged.conversationKey,
    workflowRunId: entry?.workflowRunId ?? merged.workflowRunId,
    taskId: entry?.taskId ?? merged.taskId,
    toolName: entry?.toolName ?? merged.toolName,
    profileId: entry?.profileId ?? merged.profileId,
    provider: entry?.provider ?? merged.provider,
    jobId: entry?.jobId ?? merged.jobId,
    entityType: entry?.entityType ?? merged.entityType,
    entityId: entry?.entityId ?? merged.entityId,
  }), {});
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (/bearer\s+[a-z0-9._-]+/i.test(value)) {
      return "[redacted-bearer-token]";
    }
    if (/sk-[a-z0-9]+/i.test(value)) {
      return "[redacted-secret]";
    }
    if (value.length > 8_000) {
      return `${value.slice(0, 8_000)}...[truncated]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (/token|secret|password|authorization|cookie/i.test(key)) {
          return [key, "[redacted]"];
        }
        return [key, redactValue(entry)];
      }),
    );
  }
  return value;
}

function redactAttributes(attributes?: TelemetryAttributes) {
  if (!attributes) {
    return undefined;
  }
  return redactValue(attributes) as TelemetryAttributes;
}

export class TelemetryService {
  private readonly storage = new AsyncLocalStorage<TelemetryScope>();
  private version = "unknown";
  private readonly versionReady = new DeploymentVersionService().load().then(
    (info) => { this.version = info.version; },
    () => {},
  );

  constructor(
    private readonly store = new TelemetryStore(),
    private readonly component = "app",
    private readonly defaults: TelemetryAttributes = {},
    private readonly known: TelemetryKnownFields = {},
  ) {}

  child(options: TelemetryChildOptions) {
    return new TelemetryService(
      this.store,
      options.component,
      { ...this.defaults, ...(options.defaults ?? {}) },
      mergeKnownFields(this.known, options),
    );
  }

  run<T>(context: TelemetryRunContext, fn: () => Promise<T> | T) {
    const traceId = context.traceId ?? randomHex(16);
    const scope: TelemetryScope = {
      traceId,
      component: context.component ?? this.component,
      defaults: {
        ...this.defaults,
        ...(context.attributes ?? {}),
      },
      known: mergeKnownFields(this.known, context),
      spans: [],
    };
    return this.storage.run(scope, fn);
  }

  async span<T>(
    operation: string,
    attrsOrFn: TelemetryAttributes | (() => Promise<T>) | (() => T),
    maybeFn?: () => Promise<T> | T,
  ): Promise<T> {
    return await this.runSpan(operation, attrsOrFn, maybeFn);
  }

  private runSpan<T>(
    operation: string,
    attrsOrFn: TelemetryAttributes | (() => Promise<T>) | (() => T),
    maybeFn?: () => Promise<T> | T,
  ): Promise<T> | T {
    const attributes = typeof attrsOrFn === "function" ? {} : attrsOrFn;
    const fn = (typeof attrsOrFn === "function" ? attrsOrFn : maybeFn)!;
    const active = this.currentScope();
    if (!active) {
      return this.run({}, () => this.runSpan(operation, attributes, fn));
    }

    const parsed = splitOperation(operation);
    const mergedAttributes = redactAttributes({
      ...active.defaults,
      ...this.defaults,
      ...attributes,
    }) ?? {};
    const known = mergeKnownFields(active.known, this.known, extractKnownFields(mergedAttributes));
    const parent = active.spans.at(-1);
    const span: ActiveSpan = {
      traceId: active.traceId,
      spanId: randomHex(8),
      parentSpanId: parent?.spanId,
      component: parsed.component ?? active.component,
      operation: parsed.operation,
      startedAt: nowIso(),
      startedNs: process.hrtime.bigint(),
      attributes: mergedAttributes,
      ...known,
    };

    const nextScope: TelemetryScope = {
      ...active,
      defaults: mergedAttributes,
      known,
      spans: active.spans.concat(span),
    };

    return this.storage.run(nextScope, () => {
      try {
        const result = fn();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return Promise.resolve(result)
            .then((resolved) => {
              this.flushSpan(span, "ok", "info");
              return resolved;
            })
            .catch((error) => {
              this.flushSpan(span, "error", "error", { error: normalizeError(error) });
              throw error;
            });
        }
        this.flushSpan(span, "ok", "info");
        return result;
      } catch (error) {
        this.flushSpan(span, "error", "error", { error: normalizeError(error) });
        throw error;
      }
    });
  }

  event(name: string, attributes?: TelemetryAttributes, options?: TelemetryEventOptions) {
    const active = this.currentScope();
    const parsed = splitOperation(name);
    const mergedAttributes = redactAttributes({
      ...(active?.defaults ?? {}),
      ...this.defaults,
      ...(attributes ?? {}),
    }) ?? {};
    const known = mergeKnownFields(active?.known, this.known, extractKnownFields(mergedAttributes));
    const parent = active?.spans.at(-1);
    const record: TelemetryEventRecord = {
      traceId: active?.traceId,
      spanId: parent?.spanId,
      parentSpanId: parent?.parentSpanId,
      timestamp: nowIso(),
      component: parsed.component,
      eventName: parsed.operation,
      severity: options?.level ?? "info",
      message: options?.message,
      outcome: options?.outcome,
      attributesJson: mergedAttributes,
      serviceName: SERVICE_NAME,
      serviceVersion: this.version,
      ...known,
    };
    this.writeEvent(record);
  }

  recordError(error: unknown, attributes?: TelemetryAttributes) {
    const message = error instanceof Error ? error.message : String(error);
    const component = this.component;
    const operation = typeof attributes?.operation === "string" ? attributes.operation : undefined;
    const prefix = [component, operation].filter(Boolean).join(".");
    console.error(`[error${prefix ? ` ${prefix}` : ""}] ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    this.event("app.error", {
      ...(attributes ?? {}),
      error: normalizeError(error),
    }, {
      level: "error",
      message,
      outcome: "error",
    });
  }

  async instrumentFetch(params: InstrumentedFetchParams) {
    const { url, method, operation, component, init, ...rest } = params;
    return this.span(
      operation ?? `${component ?? this.component}.fetch`,
      {
        ...(method ? { method } : {}),
        url,
        component,
        operation,
        init,
        ...rest,
      },
      async () => {
        const response = await fetch(url, init);
        this.event("network.response", {
          url,
          method: method ?? init?.method ?? "GET",
          status: response.status,
          ok: response.ok,
          component,
          operation,
          ...rest,
        }, {
          level: response.ok ? "info" : "warn",
          message: `${method ?? init?.method ?? "GET"} ${url} -> ${response.status}`,
          outcome: response.ok ? "ok" : "error",
        });
        return response;
      },
    );
  }

  instrumentSpawn(params: InstrumentedSpawnParams) {
    const { command, args, options, timeoutMs, input, operation, component, ...rest } = params;
    return this.span(
      operation ?? `${component ?? this.component}.spawn`,
      {
        command,
        args,
        cwd: options?.cwd ? String(options.cwd) : undefined,
        timeoutMs,
        hasInput: typeof input === "string",
        component,
        operation,
        ...rest,
      },
      async () => new Promise<{
        stdout: string;
        stderr: string;
        code: number;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        const child: ChildProcessWithoutNullStreams = spawn(command, args, {
          ...(options ?? {}),
          stdio: "pipe",
        } satisfies SpawnOptionsWithoutStdio);
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        const timer = timeoutMs
          ? setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
            }, timeoutMs)
          : undefined;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          if (timer) clearTimeout(timer);
          resolve({
            stdout: stdoutChunks.join(""),
            stderr: stderrChunks.join(""),
            code: code ?? -1,
            signal,
          });
        });
        if (typeof input === "string") {
          child.stdin.write(input);
        }
        child.stdin.end();
      }),
    );
  }

  instrumentStoreWrite<T>(params: InstrumentedActionParams, fn: () => Promise<T> | T) {
    return this.span(params.operation, { ...(params.attributes ?? {}), ...params }, fn);
  }

  instrumentQueueAction<T>(params: InstrumentedActionParams, fn: () => Promise<T> | T) {
    return this.span(params.operation, { ...(params.attributes ?? {}), ...params }, fn);
  }

  instrumentMethods<T extends object>(target: T, options?: InstrumentMethodsOptions): T {
    if (typeof target !== "object" || target === null) {
      return target;
    }

    const cached = AUTO_INSTRUMENTED_TARGETS.get(target);
    if (cached) {
      return cached as T;
    }

    const component = options?.component ?? this.component;
    const include = options?.include ? new Set(options.include) : null;
    const exclude = new Set(options?.exclude ?? []);
    const operationPrefix = options?.operationPrefix?.trim();
    const known = {
      conversationKey: options?.conversationKey,
      workflowRunId: options?.workflowRunId,
      taskId: options?.taskId,
      toolName: options?.toolName,
      profileId: options?.profileId,
      provider: options?.provider,
      jobId: options?.jobId,
      entityType: options?.entityType,
      entityId: options?.entityId,
    };
    const className = target.constructor?.name || "AnonymousObject";
    const methodCache = new Map<PropertyKey, unknown>();
    const instrumentation = this.child({ component, ...known });
    const proxy = new Proxy(target, {
      get: (innerTarget, property, _receiver) => {
        const value = Reflect.get(innerTarget, property, innerTarget);
        if (typeof value !== "function" || typeof property !== "string") {
          return value;
        }
        if (property === "constructor" || property.startsWith("#")) {
          return value;
        }
        if (include && !include.has(property)) {
          return value;
        }
        if (exclude.has(property)) {
          return value;
        }
        const prototype = Reflect.getPrototypeOf(innerTarget) as Record<string, unknown> | null;
        const prototypeValue = prototype?.[property];
        if (typeof prototypeValue !== "function") {
          return value;
        }
        const cachedMethod = methodCache.get(property);
        if (cachedMethod) {
          return cachedMethod;
        }

        const wrapped = (...args: unknown[]) => {
          const operationName = operationPrefix
            ? `${component}.${operationPrefix}.${property}`
            : `${component}.${property}`;
          const extraAttributes = options?.attributeFactory?.({
            methodName: property,
            args,
            className,
          });
          return instrumentation.runSpan(
            operationName,
            {
              className,
              methodName: property,
              ...(extraAttributes ?? {}),
            },
            () => value.apply(innerTarget, args),
          );
        };
        methodCache.set(property, wrapped);
        return wrapped;
      },
    });

    AUTO_INSTRUMENTED_TARGETS.set(target, proxy);
    return proxy;
  }

  private currentScope() {
    return this.storage.getStore();
  }

  private flushSpan(
    span: ActiveSpan,
    outcome: TelemetryOutcome,
    level: TelemetrySeverity,
    extraAttributes?: TelemetryAttributes,
  ) {
    const durationMs = Number(process.hrtime.bigint() - span.startedNs) / 1_000_000;
    const record: TelemetrySpanRecord = {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      component: span.component,
      operation: span.operation,
      startedAt: span.startedAt,
      endedAt: nowIso(),
      durationMs,
      outcome,
      level,
      attributesJson: redactAttributes({
        ...span.attributes,
        ...(extraAttributes ?? {}),
      }),
      serviceName: SERVICE_NAME,
      serviceVersion: this.version,
      ...mergeKnownFields(span, extractKnownFields(extraAttributes ?? {})),
    };
    this.store.insertSpan(record);
  }

  private writeEvent(record: TelemetryEventRecord) {
    this.store.insertEvent(record);
  }
}

export const telemetry = (() => {
  try {
    return new TelemetryService();
  } catch {
    return new TelemetryService(new TelemetryStore(":memory:"));
  }
})();
