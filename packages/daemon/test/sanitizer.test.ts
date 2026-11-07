import { expect, it } from "vitest";

import { contentHash, sanitizeJson, sanitizeText } from "../src/sanitizer.js";

it("redacts OpenAI and Anthropic API keys", () => {
  const res = sanitizeText("My key is sk-12345678901234567890abcdef and sk-ant-api03-abcdefghijklmn-1234567");
  expect(res.redactionCount).toBeGreaterThan(0);
  expect(res.content).toContain("[API_KEY_REDACTED]");
  expect(res.content).toContain("[ANTHROPIC_KEY_REDACTED]");
  expect(res.content).not.toContain("sk-12345678901234567890abcdef");
});

it("redacts GitHub and Slack tokens", () => {
  const res = sanitizeText("Token ghp_123456789012345678901234567890123456 and bot xoxb-12345678-abcdef");
  expect(res.content).toContain("[GITHUB_TOKEN_REDACTED]");
  expect(res.content).toContain("[SLACK_TOKEN_REDACTED]");
});

it("redacts generic password and secret patterns", () => {
  const res = sanitizeText('DB_PASSWORD="SuperSecretPassword123" and api_key: "secretkey888"');
  expect(res.content).toContain("DB_PASSWORD=[REDACTED]");
  expect(res.content).toContain("api_key=[REDACTED]");
  expect(res.content).not.toContain("SuperSecretPassword123");
});

it("omits large base64 image strings", () => {
  const b64 = "A".repeat(300);
  const res = sanitizeText(`Embedded screenshot: data:image/png;base64,${b64} in document`);
  expect(res.content).toContain("[IMAGE_DATA_OMITTED]");
  expect(res.content).not.toContain(b64);
});

it("sanitizes JSON recursively", () => {
  const clean = sanitizeJson({ name: "test-project", api_key: "sensitive-value", nested: { password: "my-db-pass", normal: "safe-text" } }) as Record<
    string,
    Record<string, string> | string
  >;
  expect(clean.name).toBe("test-project");
  expect(clean.api_key).toBe("[REDACTED]");
  expect(clean.nested).toEqual({ password: "[REDACTED]", normal: "safe-text" });
});

it("content hash stays stable for already-synced content", () => {
  // The server stores these hashes; a different formula would re-upload everything.
  expect(contentHash("hello")).toBe("5e918d2");
  expect(contentHash("")).toBe("0");
});
