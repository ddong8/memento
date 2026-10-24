import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import nodeDataChannel from "node-datachannel";
import { afterAll, describe, expect, it } from "vitest";

import { P2PHost } from "../src/p2p.js";

const host = new P2PHost();
afterAll(() => {
  host.dispose();
  nodeDataChannel.cleanup();
});

/** Plays the page: offers, takes the device's answer, then talks the file protocol on the channel. */
async function connect() {
  const pc = new nodeDataChannel.PeerConnection("page", { iceServers: [] });
  // Listen before negotiating: gathering host candidates completes within milliseconds
  const gathered = new Promise<void>((resolve) => {
    pc.onGatheringStateChange((s) => {
      if (s === "complete") resolve();
    });
  });
  const dc = pc.createDataChannel("files");
  await gathered;
  const offer = pc.localDescription()!.sdp;
  const answer = await host.answer(offer, []);
  expect(answer.error).toBeUndefined();
  pc.setRemoteDescription(answer.sdp!, "answer" as never);
  await new Promise<void>((resolve) => dc.onOpen(() => resolve()));

  const texts: Record<string, unknown>[] = [];
  const frames = new Map<number, Buffer[]>();
  dc.onMessage((msg) => {
    if (typeof msg === "string") texts.push(JSON.parse(msg) as Record<string, unknown>);
    else {
      const b = Buffer.from(msg as ArrayBuffer);
      const id = b.readUInt32BE(0);
      frames.set(id, [...(frames.get(id) ?? []), b.subarray(4)]);
    }
  });
  const reply = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const r = texts.find((t) => t.id === id);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`no reply for ${id}`);
  };
  return { pc, dc, frames, reply };
}

describe("direct (WebRTC) file transfer", () => {
  it("answers an offer, then serves file size and byte ranges on the data channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p2p-"));
    const file = join(dir, "clip.mp4");
    const data = randomBytes(300 * 1024 + 7);
    await writeFile(file, data);
    const { pc, dc, frames, reply } = await connect();

    dc.sendMessage(JSON.stringify({ id: 1, op: "stat", path: `file://${file}` }));
    expect(await reply(1)).toEqual({ id: 1, size: data.length });

    // A range spanning several 64 KB frames, as a video element asks for one
    dc.sendMessage(JSON.stringify({ id: 2, op: "read", path: file, start: 1000, end: 200_000 }));
    expect(await reply(2)).toEqual({ id: 2, done: true });
    expect(Buffer.concat(frames.get(2)!).equals(data.subarray(1000, 200_001))).toBe(true);

    dc.sendMessage(JSON.stringify({ id: 3, op: "stat", path: join(dir, "missing.mp4") }));
    expect(String((await reply(3)).error)).toContain("File not found");

    pc.close();
    await rm(dir, { recursive: true, force: true });
  }, 20_000);
});
