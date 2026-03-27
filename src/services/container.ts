/**
 * Lightweight typed service container.
 * Provides lazy, cached service resolution for the composition root.
 *
 * Services are registered as factory functions and resolved on first access.
 * The container caches instances so each service is created at most once.
 *
 * Usage:
 *   const container = new ServiceContainer();
 *   container.register("profiles", () => new ProfileService());
 *   container.register("access", () => new AccessControlService(container.resolve("profiles")));
 *   const profiles = container.resolve<ProfileService>("profiles");
 */

export class ServiceContainer {
  private readonly factories = new Map<string, () => unknown>();
  private readonly instances = new Map<string, unknown>();

  /**
   * Register a service factory. The factory is called lazily on first resolve().
   * Re-registering the same key replaces the factory and clears any cached instance.
   */
  register<T>(key: string, factory: () => T): void {
    this.factories.set(key, factory);
    this.instances.delete(key);
  }

  /**
   * Resolve a service by key. Creates and caches the instance on first call.
   * Throws if the key was never registered.
   */
  resolve<T>(key: string): T {
    const existing = this.instances.get(key);
    if (existing !== undefined) return existing as T;

    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`ServiceContainer: no factory registered for "${key}"`);
    }

    const instance = factory();
    this.instances.set(key, instance);
    return instance as T;
  }

  /** Check whether a key has been registered. */
  has(key: string): boolean {
    return this.factories.has(key);
  }

  /** Get a resolved instance if it exists, without triggering creation. */
  peek<T>(key: string): T | undefined {
    return this.instances.get(key) as T | undefined;
  }

  /** Clear all cached instances (factories remain). */
  reset(): void {
    this.instances.clear();
  }
}
