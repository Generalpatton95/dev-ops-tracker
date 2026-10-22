import { describe, expect, it } from "vitest";
import { isTestDatabaseName, resolveTestDatabase } from "./test-database";

describe("resolveTestDatabase", () => {
  it("REQ-5: runs against a database whose name ends in _test", () => {
    const url = "postgres://postgres:pw@localhost:5432/dot_test";
    expect(resolveTestDatabase({ TEST_DATABASE_URL: url })).toEqual({ run: true, url });
  });

  it("REQ-5: refuses a database whose name doesn't end in _test", () => {
    for (const url of [
      "postgres://postgres:pw@localhost:5432/dot",
      "postgres://postgres:pw@localhost:5432/dot_test_copy",
      "postgres://postgres:pw@localhost:5432/_test",
      "postgres://postgres:pw@localhost:5432/",
      "postgres://postgres:pw@localhost:5432",
    ]) {
      expect(() => resolveTestDatabase({ TEST_DATABASE_URL: url })).toThrow(/must end in "_test"/);
    }
  });

  it("REQ-5: never puts the URL or its password in the error", () => {
    for (const url of [
      "postgres://postgres:s3cret@db.example.com:5432/prod",
      "postgres://postgres:s3cret@db.example.com:5432/x_test?host=db.example.com",
      "mysql://postgres:s3cret@db.example.com:5432/x_test",
      "postgres://postgres:s3cret@db.example.com:5432/%E0%A4%A",
    ]) {
      let message = "";
      try {
        resolveTestDatabase({ TEST_DATABASE_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).not.toBe("");
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("db.example.com");
    }
  });

  it("REQ-5: accepts both postgres:// and postgresql:// with harmless query options", () => {
    for (const url of [
      "postgres://postgres:pw@localhost:5432/dot_test",
      "postgresql://postgres:pw@localhost:5432/dot_test?sslmode=disable",
    ]) {
      expect(resolveTestDatabase({ TEST_DATABASE_URL: url })).toEqual({ run: true, url });
    }
  });

  it("REQ-5: refuses schemes other than postgres: and postgresql:", () => {
    for (const url of [
      "socket:/tmp/x_test?db=prod",
      "socket:/tmp/x_test",
      "mysql://u:p@localhost/dot_test",
      "https://localhost/dot_test",
    ]) {
      expect(() => resolveTestDatabase({ TEST_DATABASE_URL: url }), url).toThrow(
        /must start with postgres:\/\/ or postgresql:\/\//,
      );
    }
  });

  it("REQ-5: refuses query keys that could point the tests at another database", () => {
    const cases: [string, string][] = [
      ["postgres://h/x_test?host=evil", "host"],
      ["postgres://h/x_test?hostaddr=10.0.0.1", "hostaddr"],
      ["postgres://h/x_test?port=6543", "port"],
      ["postgres://h/x_test?db=prod", "db"],
      ["postgres://h/x_test?database=prod", "database"],
      ["postgres://h/x_test?dbname=prod", "dbname"],
      ["postgres://h/x_test?DBNAME=prod", "dbname"],
      ["postgres://h/x_test?sslmode=require&%64b=prod", "db"],
    ];
    for (const [url, key] of cases) {
      let message = "";
      try {
        resolveTestDatabase({ TEST_DATABASE_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).toBe(
        `Refusing to run: TEST_DATABASE_URL must not set ${key} in its query string. ` +
          "Put the host, port and database in the URL itself.",
      );
      // The message names the key only, never the URL or the value.
      expect(message).not.toMatch(/evil|prod|6543|10\.0\.0\.1/);
    }
  });

  it("REQ-5: refuses a value that isn't a URL", () => {
    expect(() => resolveTestDatabase({ TEST_DATABASE_URL: "not a url" })).toThrow(/valid/);
  });

  it("REQ-5: skips with a reason when TEST_DATABASE_URL is unset outside CI", () => {
    const result = resolveTestDatabase({});
    expect(result.run).toBe(false);
    expect(result.run === false && result.reason).toMatch(/TEST_DATABASE_URL is not set/);
    expect(resolveTestDatabase({ TEST_DATABASE_URL: "  " }).run).toBe(false);
  });

  it("REQ-5: fails instead of skipping when TEST_DATABASE_URL is unset in CI", () => {
    expect(() => resolveTestDatabase({ CI: "true" })).toThrow(/TEST_DATABASE_URL is not set/);
  });
});

describe("isTestDatabaseName", () => {
  it("REQ-5: accepts only names ending in _test", () => {
    expect(isTestDatabaseName("dot_test")).toBe(true);
    expect(isTestDatabaseName("dot")).toBe(false);
    expect(isTestDatabaseName("_test")).toBe(false);
    expect(isTestDatabaseName("dot_TEST")).toBe(false);
  });
});
