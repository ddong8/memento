import { describe, expect, it } from "vitest";
import { fetchEntityDetail, findEntityDetail, type MemoryGet } from "../src/lib/memory-entity";

const ID = "0b6f3c9e-1d2a-4c5b-8e7f-9a0b1c2d3e4f";
const detail = {
  id: ID,
  name: "Memento",
  type: "project",
  summary: null,
  observations: [],
  outgoing_relations: [],
  incoming_relations: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake API: answers by path, records what was asked. */
function fakeApi(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const get: MemoryGet = async (path) => {
    asked.push(path);
    const route = routes[path];
    if (!route) return json({ detail: "Not Found" }, 404);
    return route();
  };
  return { get, asked };
}

describe("memory entity lookup", () => {
  it("returns the entity by id", async () => {
    const { get } = fakeApi({ [`/api/memory/entities/${ID}`]: () => json(detail) });
    expect(await fetchEntityDetail(ID, get)).toEqual(detail);
  });

  it("returns null instead of the error body, which used to crash the page", async () => {
    // a missing entity is a 200 with {"error": "not found"}; a non-UUID id is a 422
    const { get } = fakeApi({
      [`/api/memory/entities/${ID}`]: () => json({ error: "not found" }),
      "/api/memory/entities/correction_042b76c0": () => json({ detail: [{ msg: "Input should be a valid UUID" }] }, 422),
    });
    expect(await fetchEntityDetail(ID, get)).toBeNull();
    expect(await fetchEntityDetail("correction_042b76c0", get)).toBeNull();
  });

  it("returns null when the request fails", async () => {
    const get: MemoryGet = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await fetchEntityDetail(ID, get)).toBeNull();
    expect(await findEntityDetail("Memento", get)).toBeNull();
  });

  it("finds a name through the search, matching the whole name regardless of case", async () => {
    const { get, asked } = fakeApi({
      "/api/memory/search?q=memento&limit=5": () =>
        json([
          { type: "entity", id: "other", name: "Memento Desktop" },
          { type: "observation", id: "obs", name: "Memento", content: "..." },
          { type: "entity", id: ID, name: "Memento" },
        ]),
      [`/api/memory/entities/${ID}`]: () => json(detail),
    });
    expect(await findEntityDetail("memento", get)).toEqual(detail);
    expect(asked).toEqual(["/api/memory/search?q=memento&limit=5", `/api/memory/entities/${ID}`]);
  });

  it("does not take a partial match or ask by a non-UUID id", async () => {
    // a core-memory rule key: no entity has this name
    const { get, asked } = fakeApi({
      "/api/memory/search?q=correction_042b76c0&limit=5": () => json([{ type: "entity", id: ID, name: "correction" }]),
    });
    expect(await findEntityDetail("correction_042b76c0", get)).toBeNull();
    expect(asked).toEqual(["/api/memory/search?q=correction_042b76c0&limit=5"]);
  });

  it("asks a UUID directly and ignores an empty name", async () => {
    const { get, asked } = fakeApi({ [`/api/memory/entities/${ID}`]: () => json(detail) });
    expect(await findEntityDetail(ID, get)).toEqual(detail);
    expect(await findEntityDetail("  ", get)).toBeNull();
    expect(asked).toEqual([`/api/memory/entities/${ID}`]);
  });
});
