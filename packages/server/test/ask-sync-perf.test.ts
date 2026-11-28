import { describe, expect, it, vi } from "vitest";

import { etagMatches } from "../src/routes/ask-conversations";
import { sanitizeTurnsForResponse } from "../src/services/ask-store";
import { syncConversation } from "../src/services/session-timeline";

describe("Ask resume sync performance optimizations", () => {
  describe("etagMatches (RFC 9110 weak comparison)", () => {
    const strong = '"1234567890abcdef1234567890abcdef12345678"';

    it("matches exact strong ETag", () => {
      expect(etagMatches(strong, strong)).toBe(true);
    });

    it("matches gzip/proxy-weakened W/ ETag", () => {
      expect(etagMatches(`W/${strong}`, strong)).toBe(true);
      expect(etagMatches(`w/${strong}`, strong)).toBe(true);
    });

    it("matches inside comma-separated If-None-Match lists and wildcard", () => {
      expect(etagMatches(`"other", W/${strong}, "third"`, strong)).toBe(true);
      expect(etagMatches("*", strong)).toBe(true);
    });

    it("rejects empty or non-matching headers", () => {
      expect(etagMatches(undefined, strong)).toBe(false);
      expect(etagMatches("", strong)).toBe(false);
      expect(etagMatches('"deadbeef"', strong)).toBe(false);
      expect(etagMatches('W/"deadbeef"', strong)).toBe(false);
    });
  });

  describe("sanitizeTurnsForResponse({ slimOlder: true })", () => {
    it("keeps the latest 6 turns verbatim while slimming older turns toolCalls events & duplicate stdout", () => {
      const longDetail = "d".repeat(1200);
      const longOutput = "o".repeat(1500);
      const sharedContent = "Final assistant answer ".repeat(50);

      const makeTurn = (idx: number) => ({
        role: idx % 2 === 0 ? "user" : "assistant",
        content: sharedContent,
        thinking: `Thinking for turn ${idx}`,
        toolCalls:
          idx % 2 === 1
            ? [
                {
                  id: `call_${idx}`,
                  name: "run_on_device",
                  status: "executed",
                  result: {
                    status: "succeeded",
                    stdout: sharedContent,
                    events: [
                      { kind: "thinking", text: "huge redundant thinking blob ".repeat(100) },
                      ...Array.from({ length: 80 }, (_, eIdx) => ({
                        kind: "tool",
                        id: `t_${eIdx}`,
                        name: "Bash",
                        detail: longDetail,
                        output: longOutput,
                        status: "done",
                      })),
                    ],
                  },
                },
              ]
            : undefined,
      });

      // 10 turns total: indices 0..3 are older, indices 4..9 are the recent 6 turns
      const rawTurns = Array.from({ length: 10 }, (_, i) => makeTurn(i));
      const slimmed = sanitizeTurnsForResponse(rawTurns, undefined, { slimOlder: true });
      expect(slimmed).toHaveLength(10);

      // Older assistant turn (index 1): slimmed
      const oldTc = (slimmed[1]!.toolCalls as Array<{ result: Record<string, unknown> }>)[0]!;
      const oldEvents = oldTc.result.events as Array<Record<string, unknown>>;
      expect(oldEvents.some((e) => e.kind === "thinking")).toBe(false);
      expect(oldEvents.length).toBeLessThanOrEqual(60);
      expect(String(oldEvents[0]!.detail).length).toBeLessThanOrEqual(401);
      expect(String(oldEvents[0]!.output).length).toBeLessThanOrEqual(601);
      // Duplicate stdout matching turn.content was cleared on older turns
      expect(oldTc.result.stdout).toBe("");
      // Turn-level thinking & content remain intact
      expect(slimmed[1]!.thinking).toBe("Thinking for turn 1");
      expect(slimmed[1]!.content).toBe(sharedContent);

      // Recent assistant turn (index 9, inside last 6): kept verbatim
      const recentTc = (slimmed[9]!.toolCalls as Array<{ result: Record<string, unknown> }>)[0]!;
      const recentEvents = recentTc.result.events as Array<Record<string, unknown>>;
      expect(recentEvents).toHaveLength(81);
      expect(recentEvents[0]!.kind).toBe("thinking");
      expect(String(recentEvents[1]!.detail)).toBe(longDetail);
      expect(recentTc.result.stdout).toBe(sharedContent);
    });
  });

  describe("syncConversation zero-TOAST fast path", () => {
    it("skips reading the TOASTed turns column when document contentHash matches _timeline_hash", async () => {
      const selectCalls: Array<Record<string, unknown>> = [];

      // First select: askConversations metadata (id, title, userId, config)
      // Second select: documents (id, title, contentHash, toolId)
      const results = [
        [
          {
            id: "conv-1",
            title: "Test Chat",
            userId: "user-1",
            config: {
              document_id: "doc-1",
              _timeline_hash: "sha-unchanged",
              _timeline_fmt: 2,
            },
          },
        ],
        [
          {
            id: "doc-1",
            title: "Test Chat",
            contentHash: "sha-unchanged",
            toolId: "antigravity",
          },
        ],
      ];

      const mockDb = {
        select: vi.fn((cols: Record<string, unknown>) => {
          selectCalls.push(cols);
          const idx = selectCalls.length - 1;
          const chain = {
            from: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: () => Promise.resolve(results[idx] ?? []),
          };
          return chain;
        }),
        update: vi.fn(),
      };

      const changed = await syncConversation(mockDb as never, "conv-1");
      expect(changed).toBe(false);
      expect(selectCalls).toHaveLength(2);
      // Confirm neither query selected the `turns` column
      for (const cols of selectCalls) {
        expect("turns" in cols).toBe(false);
      }
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});
