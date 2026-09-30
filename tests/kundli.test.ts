// The chart must be right or absent: these tests pin house numbering and planet placement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKundli, parsePlanets, signIndex } from "../src/lib/kundli.ts";

test("sign names: Hindi, Sanskrit and English spellings", () => {
  assert.equal(signIndex("Tula"), 6);
  assert.equal(signIndex("libra"), 6);
  assert.equal(signIndex("Simha"), 4);
  assert.equal(signIndex("nonsense"), -1);
});

test("houses are numbered from the lagna; Asc in house 1; Moon in its real house", () => {
  const k = buildKundli({ lagna: "Kanya", tobKnown: true, moonSign: "Tula" })!;
  assert.equal(k.basis, "lagna");
  assert.deepEqual(k.houses.map((h) => h.sign), [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5]);
  assert.deepEqual(k.houses[0].items, ["Asc"]);
  assert.deepEqual(k.houses[1].items, ["Mo"]); // Tula is 2nd from Kanya
});

test("no birth time → Moon chart (Chandra kundli), no Asc", () => {
  const k = buildKundli({ lagna: "Kanya", tobKnown: false, moonSign: "Makar" })!;
  assert.equal(k.basis, "moon");
  assert.equal(k.houses[0].sign, 10);
  assert.deepEqual(k.houses[0].items, ["Mo"]);
  assert.ok(!k.houses.some((h) => h.items.includes("Asc")));
});

test("supplied planets are placed with degrees; the given moon sign always wins", () => {
  const k = buildKundli({
    lagna: "Mesh", tobKnown: true, moonSign: "Tula",
    planets: "Su:Vrishabh 0.3;Mo:Kark 5;Sa:Vrishabh 3.7;Xy:Mesh;Ma:Nowhere",
  })!;
  assert.deepEqual(k.houses[1].items, ["Su 0.3°", "Sa 3.7°"]);
  assert.deepEqual(k.houses[6].items, ["Mo"], "Mo stays in Tula (7th from Mesh), wrong Mo entry ignored");
  assert.equal(k.houses.flatMap((h) => h.items).length, 4, "Asc + Mo + Su + Sa; unknown entries dropped");
});

test("planet input problems are reported for the import", () => {
  const { planets, problems } = parsePlanets({ Sun: "Mesh 12.4", Pluto: "Kark", Ma: "Blue 3" });
  assert.equal(planets.length, 1);
  assert.equal(problems.length, 2);
});

test("an unknown moon sign means no chart rather than a wrong one", () => {
  assert.equal(buildKundli({ lagna: "Mesh", tobKnown: true, moonSign: "???" }), null);
});
