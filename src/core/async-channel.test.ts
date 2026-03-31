import { test, expect } from "bun:test";
import { AsyncChannel } from "./async-channel";

test("push then consume", async () => {
  const ch = new AsyncChannel<number>();
  ch.push(1);
  ch.push(2);
  ch.push(3);
  ch.close();

  const values: number[] = [];
  for await (const v of ch) {
    values.push(v);
  }
  expect(values).toEqual([1, 2, 3]);
});

test("consume awaits push", async () => {
  const ch = new AsyncChannel<string>();
  const iter = ch[Symbol.asyncIterator]();

  // Push after a microtask delay
  setTimeout(() => ch.push("hello"), 5);
  const result = await iter.next();
  expect(result).toEqual({ value: "hello", done: false });

  ch.close();
  const done = await iter.next();
  expect(done.done).toBe(true);
});

test("close resolves waiting consumer", async () => {
  const ch = new AsyncChannel<number>();
  const iter = ch[Symbol.asyncIterator]();

  // Consumer waits, then channel closes
  setTimeout(() => ch.close(), 5);
  const result = await iter.next();
  expect(result.done).toBe(true);
});

test("push after close is a no-op", () => {
  const ch = new AsyncChannel<number>();
  ch.close();
  ch.push(42); // should not throw
  expect(ch.isClosed).toBe(true);
});

test("interleaved push and consume", async () => {
  const ch = new AsyncChannel<number>();
  const iter = ch[Symbol.asyncIterator]();

  ch.push(1);
  expect(await iter.next()).toEqual({ value: 1, done: false });

  ch.push(2);
  ch.push(3);
  expect(await iter.next()).toEqual({ value: 2, done: false });
  expect(await iter.next()).toEqual({ value: 3, done: false });

  ch.close();
  expect((await iter.next()).done).toBe(true);
});
