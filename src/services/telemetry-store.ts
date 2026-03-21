import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { resolveRuntimePath } from "./runtime-root";

export type TelemetrySeverity = "debug" | "info" | "warn" | "error";
export type TelemetryOutcome = "ok" | "error" | "cancelled" | "timeout" | "rejected";

export type TelemetryKnownFields = {
  conversationKey?: string;
  workflowRunId?: string;
  taskId?: string;
  toolName?: string;
  profileId?: string;
  provider?: string;
  jobId?: string;
  entityType?: string;
  entityId?: string;
};

export type TelemetrySpanRecord = TelemetryKnownFields & {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  component: string;
  operation: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: TelemetryOutcome;
  level: TelemetrySeverity;
  attributesJson?: Record<string, unknown>;
  serviceName: string;
  serviceVersion: string;
};

export type TelemetryEventRecord = TelemetryKnownFields & {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  timestamp: string;
  component: string;
  eventName: string;
  severity: TelemetrySeverity;
  message?: string;
  outcome?: TelemetryOutcome;
  attributesJson?: Record<string, unknown>;
  serviceName: string;
  serviceVersion: string;
};

export type TelemetryQueryParams = TelemetryKnownFields & {
  traceId?: string;
  spanId?: string;
  component?: string;
  operation?: string;
  eventName?: string;
  outcome?: TelemetryOutcome | "all";
  level?: TelemetrySeverity | "all";
  since?: string;
  until?: string;
  query?: string;
  limit: number;
};

type TelemetryMigrationState = {
  key: string;
  completedAt: string;
};

function getStorePath() {
  if (process.env.NODE_ENV === "test") {
    return ":memory:";
  }
  return resolveRuntimePath("telemetry.sqlite");
}

function isInMemoryDbPath(value: string) {
  return value === ":memory:";
}

function normalizeLikePattern(value: string) {
  return `%${value.trim().toLowerCase()}%`;
}

export class TelemetryStore {
  private readonly db: Database;

  constructor(private readonly dbPath = getStorePath()) {
    if (!isInMemoryDbPath(this.dbPath)) {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        component TEXT NOT NULL,
        operation TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        outcome TEXT NOT NULL,
        level TEXT NOT NULL,
        conversation_key TEXT,
        workflow_run_id TEXT,
        task_id TEXT,
        tool_name TEXT,
        profile_id TEXT,
        provider TEXT,
        job_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        attributes_json TEXT,
        service_name TEXT NOT NULL,
        service_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT,
        span_id TEXT,
        parent_span_id TEXT,
        timestamp TEXT NOT NULL,
        component TEXT NOT NULL,
        event_name TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT,
        outcome TEXT,
        conversation_key TEXT,
        workflow_run_id TEXT,
        task_id TEXT,
        tool_name TEXT,
        profile_id TEXT,
        provider TEXT,
        job_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        attributes_json TEXT,
        service_name TEXT NOT NULL,
        service_version TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS telemetry_fts USING fts5(
        row_type UNINDEXED,
        row_id UNINDEXED,
        body
      );

      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, span_id);
      CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
      CREATE INDEX IF NOT EXISTS idx_spans_component ON spans(component, operation);
      CREATE INDEX IF NOT EXISTS idx_spans_timestamp ON spans(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_spans_corr ON spans(conversation_key, workflow_run_id, task_id, tool_name, profile_id);
      CREATE INDEX IF NOT EXISTS idx_spans_entity ON spans(entity_type, entity_id, job_id, provider);

      CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id, span_id);
      CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_span_id);
      CREATE INDEX IF NOT EXISTS idx_events_component ON events(component, event_name);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_corr ON events(conversation_key, workflow_run_id, task_id, tool_name, profile_id);
      CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id, job_id, provider);
    `);
  }

  getPath() {
    return this.dbPath;
  }

  hasMigration(key: string) {
    const row = this.db.query(
      "SELECT key, completed_at FROM migrations WHERE key = ?1 LIMIT 1",
    ).get(key) as { key: string; completed_at: string } | null;
    return row ? { key: row.key, completedAt: row.completed_at } satisfies TelemetryMigrationState : null;
  }

  completeMigration(key: string, completedAt: string) {
    this.db.query(
      `INSERT INTO migrations (key, completed_at)
       VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET completed_at = excluded.completed_at`,
    ).run(key, completedAt);
  }

  insertSpan(record: TelemetrySpanRecord) {
    const result = this.db.query(
      `INSERT INTO spans (
        trace_id, span_id, parent_span_id, component, operation, started_at, ended_at,
        duration_ms, outcome, level, conversation_key, workflow_run_id, task_id, tool_name,
        profile_id, provider, job_id, entity_type, entity_id, attributes_json,
        service_name, service_version
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7,
        ?8, ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22
      )`,
    ).run(
      record.traceId,
      record.spanId,
      record.parentSpanId ?? null,
      record.component,
      record.operation,
      record.startedAt,
      record.endedAt,
      record.durationMs,
      record.outcome,
      record.level,
      record.conversationKey ?? null,
      record.workflowRunId ?? null,
      record.taskId ?? null,
      record.toolName ?? null,
      record.profileId ?? null,
      record.provider ?? null,
      record.jobId ?? null,
      record.entityType ?? null,
      record.entityId ?? null,
      record.attributesJson ? JSON.stringify(record.attributesJson) : null,
      record.serviceName,
      record.serviceVersion,
    );
    const rowId = Number(result.lastInsertRowid);
    this.insertFts("span", rowId, [
      record.component,
      record.operation,
      record.outcome,
      record.attributesJson ? JSON.stringify(record.attributesJson) : "",
    ].filter(Boolean).join(" "));
  }

  insertEvent(record: TelemetryEventRecord) {
    const result = this.db.query(
      `INSERT INTO events (
        trace_id, span_id, parent_span_id, timestamp, component, event_name, severity, message,
        outcome, conversation_key, workflow_run_id, task_id, tool_name, profile_id, provider,
        job_id, entity_type, entity_id, attributes_json, service_name, service_version
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
        ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21
      )`,
    ).run(
      record.traceId ?? null,
      record.spanId ?? null,
      record.parentSpanId ?? null,
      record.timestamp,
      record.component,
      record.eventName,
      record.severity,
      record.message ?? null,
      record.outcome ?? null,
      record.conversationKey ?? null,
      record.workflowRunId ?? null,
      record.taskId ?? null,
      record.toolName ?? null,
      record.profileId ?? null,
      record.provider ?? null,
      record.jobId ?? null,
      record.entityType ?? null,
      record.entityId ?? null,
      record.attributesJson ? JSON.stringify(record.attributesJson) : null,
      record.serviceName,
      record.serviceVersion,
    );
    const rowId = Number(result.lastInsertRowid);
    this.insertFts("event", rowId, [
      record.component,
      record.eventName,
      record.message ?? "",
      record.outcome ?? "",
      record.attributesJson ? JSON.stringify(record.attributesJson) : "",
    ].filter(Boolean).join(" "));
  }

  query(params: TelemetryQueryParams) {
    return {
      spans: this.querySpans(params),
      events: this.queryEvents(params),
    };
  }

  private querySpans(params: TelemetryQueryParams) {
    const where: string[] = [];
    const values: unknown[] = [];
    const push = (value: unknown) => {
      values.push(value);
      return `?${values.length}`;
    };

    if (params.traceId) where.push(`trace_id = ${push(params.traceId)}`);
    if (params.spanId) where.push(`span_id = ${push(params.spanId)}`);
    if (params.component) where.push(`component = ${push(params.component)}`);
    if (params.operation) where.push(`operation = ${push(params.operation)}`);
    if (params.outcome && params.outcome !== "all") where.push(`outcome = ${push(params.outcome)}`);
    if (params.level && params.level !== "all") where.push(`level = ${push(params.level)}`);
    if (params.since) where.push(`started_at >= ${push(params.since)}`);
    if (params.until) where.push(`started_at <= ${push(params.until)}`);
    this.pushKnownFieldWhere(where, push, params);
    if (params.query?.trim()) {
      const pattern = normalizeLikePattern(params.query);
      where.push(`(
        lower(component) LIKE ${push(pattern)}
        OR lower(operation) LIKE ${push(pattern)}
        OR lower(coalesce(attributes_json, '')) LIKE ${push(pattern)}
      )`);
    }

    const rows = this.db.query(
      `SELECT
        trace_id, span_id, parent_span_id, component, operation, started_at, ended_at,
        duration_ms, outcome, level, conversation_key, workflow_run_id, task_id, tool_name,
        profile_id, provider, job_id, entity_type, entity_id, attributes_json,
        service_name, service_version
      FROM spans
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY started_at DESC
      LIMIT ${push(params.limit)}`,
    ).all(...values as never[]) as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      traceId: String(row.trace_id),
      spanId: String(row.span_id),
      parentSpanId: row.parent_span_id ? String(row.parent_span_id) : undefined,
      component: String(row.component),
      operation: String(row.operation),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      durationMs: Number(row.duration_ms),
      outcome: row.outcome as TelemetryOutcome,
      level: row.level as TelemetrySeverity,
      conversationKey: row.conversation_key ? String(row.conversation_key) : undefined,
      workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : undefined,
      taskId: row.task_id ? String(row.task_id) : undefined,
      toolName: row.tool_name ? String(row.tool_name) : undefined,
      profileId: row.profile_id ? String(row.profile_id) : undefined,
      provider: row.provider ? String(row.provider) : undefined,
      jobId: row.job_id ? String(row.job_id) : undefined,
      entityType: row.entity_type ? String(row.entity_type) : undefined,
      entityId: row.entity_id ? String(row.entity_id) : undefined,
      attributesJson: row.attributes_json ? JSON.parse(String(row.attributes_json)) as Record<string, unknown> : undefined,
      serviceName: String(row.service_name),
      serviceVersion: String(row.service_version),
    }));
  }

  private queryEvents(params: TelemetryQueryParams) {
    const where: string[] = [];
    const values: unknown[] = [];
    const push = (value: unknown) => {
      values.push(value);
      return `?${values.length}`;
    };

    if (params.traceId) where.push(`trace_id = ${push(params.traceId)}`);
    if (params.spanId) where.push(`span_id = ${push(params.spanId)}`);
    if (params.component) where.push(`component = ${push(params.component)}`);
    if (params.eventName) where.push(`event_name = ${push(params.eventName)}`);
    if (params.outcome && params.outcome !== "all") where.push(`outcome = ${push(params.outcome)}`);
    if (params.level && params.level !== "all") where.push(`severity = ${push(params.level)}`);
    if (params.since) where.push(`timestamp >= ${push(params.since)}`);
    if (params.until) where.push(`timestamp <= ${push(params.until)}`);
    this.pushKnownFieldWhere(where, push, params);
    if (params.query?.trim()) {
      const pattern = normalizeLikePattern(params.query);
      where.push(`(
        lower(component) LIKE ${push(pattern)}
        OR lower(event_name) LIKE ${push(pattern)}
        OR lower(coalesce(message, '')) LIKE ${push(pattern)}
        OR lower(coalesce(attributes_json, '')) LIKE ${push(pattern)}
      )`);
    }

    const rows = this.db.query(
      `SELECT
        trace_id, span_id, parent_span_id, timestamp, component, event_name, severity, message,
        outcome, conversation_key, workflow_run_id, task_id, tool_name, profile_id, provider,
        job_id, entity_type, entity_id, attributes_json, service_name, service_version
      FROM events
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY timestamp DESC
      LIMIT ${push(params.limit)}`,
    ).all(...values as never[]) as Array<Record<string, string | null>>;

    return rows.map((row) => ({
      traceId: row.trace_id ? String(row.trace_id) : undefined,
      spanId: row.span_id ? String(row.span_id) : undefined,
      parentSpanId: row.parent_span_id ? String(row.parent_span_id) : undefined,
      timestamp: String(row.timestamp),
      component: String(row.component),
      eventName: String(row.event_name),
      severity: row.severity as TelemetrySeverity,
      message: row.message ? String(row.message) : undefined,
      outcome: row.outcome ? row.outcome as TelemetryOutcome : undefined,
      conversationKey: row.conversation_key ? String(row.conversation_key) : undefined,
      workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : undefined,
      taskId: row.task_id ? String(row.task_id) : undefined,
      toolName: row.tool_name ? String(row.tool_name) : undefined,
      profileId: row.profile_id ? String(row.profile_id) : undefined,
      provider: row.provider ? String(row.provider) : undefined,
      jobId: row.job_id ? String(row.job_id) : undefined,
      entityType: row.entity_type ? String(row.entity_type) : undefined,
      entityId: row.entity_id ? String(row.entity_id) : undefined,
      attributesJson: row.attributes_json ? JSON.parse(String(row.attributes_json)) as Record<string, unknown> : undefined,
      serviceName: String(row.service_name),
      serviceVersion: String(row.service_version),
    }));
  }

  private pushKnownFieldWhere(
    where: string[],
    push: (value: unknown) => string,
    params: TelemetryKnownFields,
  ) {
    if (params.conversationKey) where.push(`conversation_key = ${push(params.conversationKey)}`);
    if (params.workflowRunId) where.push(`workflow_run_id = ${push(params.workflowRunId)}`);
    if (params.taskId) where.push(`task_id = ${push(params.taskId)}`);
    if (params.toolName) where.push(`tool_name = ${push(params.toolName)}`);
    if (params.profileId) where.push(`profile_id = ${push(params.profileId)}`);
    if (params.provider) where.push(`provider = ${push(params.provider)}`);
    if (params.jobId) where.push(`job_id = ${push(params.jobId)}`);
    if (params.entityType) where.push(`entity_type = ${push(params.entityType)}`);
    if (params.entityId) where.push(`entity_id = ${push(params.entityId)}`);
  }

  private insertFts(rowType: "span" | "event", rowId: number, body: string) {
    this.db.query(
      "INSERT INTO telemetry_fts (row_type, row_id, body) VALUES (?1, ?2, ?3)",
    ).run(rowType, rowId, body);
  }
}
