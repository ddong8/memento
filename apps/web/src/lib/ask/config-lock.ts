/**
 * A conversation that has turns keeps the agent, device, code device, project, session and folder it
 * started with: its turns are that agent's session on that device, in that folder. Switching any of them
 * would send the next question to another tool or session while the history on screen (and sent along
 * as context) is this one's. A new chat is the way to use other ones. Model and effort can still change:
 * every tool goes on with the same session on another model.
 */
export function conversationConfigLocked(turns: readonly unknown[]): boolean {
  return turns.length > 0;
}

