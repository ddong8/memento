// Antigravity 2.34's desktop app keeps its language server's CSRF token to the processes it starts (no
// --csrf_token argument, an empty csrfToken in its page), so agentapi calls from the daemon come back
// "missing CSRF token": tasks go to Google's agy CLI then, not round every model tier.
import { expect, it } from "vitest";

import { isAppAuthRejection } from "../src/antigravity.js";

it("tells the language server's CSRF rejection from other failures", () => {
  const reply =
    '{ "response": {}, "error": "failed to fetch available models: rpc error: code = Unauthenticated desc = unauthenticated: missing CSRF token" }';
  expect(isAppAuthRejection(reply)).toBe(true);
  expect(isAppAuthRejection("rpc error: code = Unauthenticated desc = invalid CSRF token")).toBe(true);
  expect(isAppAuthRejection("No capacity available for model claude-opus-5-5-high (code 503)")).toBe(false);
  expect(isAppAuthRejection("conversation not found")).toBe(false);
});
