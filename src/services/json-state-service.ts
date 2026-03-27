import fs from "node:fs";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated } from "./runtime-root";

/**
 * Generic base class for JSON-backed state services.
 *
 * Subclasses provide a state type `T`, a `normalize(raw: unknown): T` method,
 * and a file path (via the constructor, typically from `resolveRuntimePath()`).
 */
export abstract class JsonStateService<T> {
  constructor(protected readonly filePath: string) {}

  protected abstract normalize(raw: unknown): T;

  load(): T {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      return this.normalize(raw);
    } catch {
      return this.normalize(undefined);
    }
  }

  save(state: T): T {
    assertTestRuntimeRootIsIsolated(this.constructor.name);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const normalized = this.normalize(state);
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    return normalized;
  }
}
