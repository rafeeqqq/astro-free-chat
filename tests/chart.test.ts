import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChart } from "../src/lib/chart.ts";

// Regression reference (made-up person: 5 Nov 2002, 03:10, Guntur): Tula moon, Kanya lagna, Shani–Ketu in Sep 2026.
// The same code matched a real Astrolokal chart exactly when it was built.
test("computes moon sign, lagna, dasha and planets like the app does", () => {
  const c = computeChart({ dob: "2002-11-05", tob: "03:10", lat: 16.31, lon: 80.44 }, new Date("2026-09-25"));
  assert.equal(c.moon_sign, "Tula");
  assert.equal(c.lagna, "Kanya");
  assert.equal(c.mahadasha, "Shani");
  assert.equal(c.antardasha, "Ketu");
  assert.equal(c.planets.Su, "Tula 18.4");
  assert.equal(c.planets.Mo, "Tula 19.0");
  assert.equal(c.planets.Ra, "Vrishabh 16.2");
});

test("no birth time → no lagna, still a moon sign and dasha", () => {
  const c = computeChart({ dob: "1978-11-21", tob: null, lat: 25.59, lon: 85.14 });
  assert.equal(c.lagna, null);
  assert.ok(c.moon_sign && c.mahadasha && c.antardasha);
});

test("rejects a bad date", () => {
  assert.throws(() => computeChart({ dob: "1990-13-45", tob: null, lat: 28.6, lon: 77.2 }));
});
