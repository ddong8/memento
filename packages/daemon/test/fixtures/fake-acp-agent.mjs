// A tiny ACP agent for tests: one session, one prompt turn that streams text, runs a tool needing permission.
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let permId = 900;
let promptId = null;
let sid = "s-new";
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === "session/load") {
    sid = m.params.sessionId;
    send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "（旧历史）" } } } });
    return send({ id: m.id, result: {} });
  }
  if (m.method === "session/new") return send({ id: m.id, result: { sessionId: sid } });
  if (m.method === "session/prompt") {
    promptId = m.id;
    const text = m.params.prompt[0].text;
    send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `收到：${text}` } } } });
    send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "pending" } } });
    return send({ id: ++permId, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "t1", kind: "execute", title: "npm test" },
      options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } });
  }
  if (m.id === permId && m.result) {
    const picked = m.result.outcome.optionId;
    send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: picked === "ok" ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: picked === "ok" ? "12 passed" : "denied" } }] } } });
    return send({ id: promptId, result: { stopReason: "end_turn" } });
  }
});
