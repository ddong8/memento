// @vitest-environment happy-dom
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCartoonAvatar, RECIPES, recipeFor } from "../src/components/persona/CartoonAvatar3D";
import { AVATAR_PRESETS } from "../src/components/persona/avatarPresets";

// 2026-11-17: the persona's 3D stage showed one generic armoured soldier for every person, whatever
// they picked at onboarding (the user: 极客全栈架构师, black-rimmed glasses, hoodie, code ring).

describe("the 3D persona figure", () => {
  const people = AVATAR_PRESETS.filter((p) => p.gender !== "agent");

  it("is built from the preset the user picked, for every person preset", () => {
    for (const p of people) {
      expect(RECIPES[p.id], p.id).toBeDefined();
      const fig = buildCartoonAvatar({ presetId: p.id, gender: p.gender as "male" | "female", outfitColor: p.outfitColor, themeColor: p.themeColor }, p);
      let meshes = 0;
      fig.group.traverse((o) => { if (o instanceof THREE.Mesh) meshes++; });
      expect(meshes, p.id).toBeGreaterThan(40);
      fig.update({ elapsed: 3, dimension: "brain", lookX: 0.3, lookY: -0.2, nod: 0.1, follow: true });
      fig.dispose();
    }
  });

  it("wears the preset's features", () => {
    expect(recipeFor({ presetId: "geek_male", gender: "male" })).toMatchObject({ eyewear: "glasses", outfit: "hoodie" });
    expect(recipeFor({ presetId: "geek_female", gender: "female" })).toMatchObject({ eyewear: "thin_glasses", outfit: "hoodie", hair: "long" });
    expect(recipeFor({ presetId: "cyber_male", gender: "male" })).toMatchObject({ eyewear: "visor" });
    expect(recipeFor({ presetId: "vitality_female", gender: "female" })).toMatchObject({ catHeadphones: true });
    expect(recipeFor({ presetId: "elite_female", gender: "female" })).toMatchObject({ hair: "bob", outfit: "suit" });
  });

  it("takes the user's own outfit colour", () => {
    const fig = buildCartoonAvatar({ presetId: "geek_male", gender: "male", outfitColor: "#123456", themeColor: "#8B5CF6" });
    const colours = new Set<string>();
    fig.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshToonMaterial) colours.add(o.material.color.getHexString());
    });
    expect(colours.has(new THREE.Color("#123456").getHexString())).toBe(true);
    fig.dispose();
  });
});
