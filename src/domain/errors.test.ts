import { test, expect, describe } from "bun:test";
import {
  OpenElinaroError,
  NotFoundError,
  ValidationError,
  ConfigurationError,
  AuthorizationError,
} from "./errors";

describe("OpenElinaroError", () => {
  test("sets code, message, and name", () => {
    const err = new OpenElinaroError("TEST", "something broke");
    expect(err.code).toBe("TEST");
    expect(err.message).toBe("something broke");
    expect(err.name).toBe("OpenElinaroError");
  });

  test("is an instance of Error", () => {
    const err = new OpenElinaroError("X", "msg");
    expect(err).toBeInstanceOf(Error);
  });

  test("supports cause via ErrorOptions", () => {
    const cause = new Error("root");
    const err = new OpenElinaroError("X", "wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("NotFoundError", () => {
  test("formats message with entity and id", () => {
    const err = new NotFoundError("User", "42");
    expect(err.message).toBe("User not found: 42");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.name).toBe("NotFoundError");
  });

  test("formats message with entity only when id is omitted", () => {
    const err = new NotFoundError("Config");
    expect(err.message).toBe("Config not found");
  });

  test("is an instance of OpenElinaroError", () => {
    expect(new NotFoundError("X")).toBeInstanceOf(OpenElinaroError);
  });
});

describe("ValidationError", () => {
  test("sets code to VALIDATION", () => {
    const err = new ValidationError("bad input");
    expect(err.code).toBe("VALIDATION");
    expect(err.name).toBe("ValidationError");
    expect(err.message).toBe("bad input");
  });

  test("is an instance of OpenElinaroError", () => {
    expect(new ValidationError("x")).toBeInstanceOf(OpenElinaroError);
  });
});

describe("ConfigurationError", () => {
  test("sets code to CONFIGURATION", () => {
    const err = new ConfigurationError("missing key");
    expect(err.code).toBe("CONFIGURATION");
    expect(err.name).toBe("ConfigurationError");
  });

  test("is an instance of OpenElinaroError", () => {
    expect(new ConfigurationError("x")).toBeInstanceOf(OpenElinaroError);
  });
});

describe("AuthorizationError", () => {
  test("sets code to AUTHORIZATION", () => {
    const err = new AuthorizationError("denied");
    expect(err.code).toBe("AUTHORIZATION");
    expect(err.name).toBe("AuthorizationError");
  });

  test("is an instance of OpenElinaroError", () => {
    expect(new AuthorizationError("x")).toBeInstanceOf(OpenElinaroError);
  });

  test("all error types can be caught as OpenElinaroError", () => {
    const errors = [
      new NotFoundError("X"),
      new ValidationError("X"),
      new ConfigurationError("X"),
      new AuthorizationError("X"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(OpenElinaroError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
