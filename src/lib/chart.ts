// Computes the chart facts the chat needs (moon sign, lagna, Vimshottari dasha, planets) from birth details.
// Used by the daily sync to build each user's kundli from their birth details.
// Sidereal (Lahiri ayanamsa), mean lunar node, whole-sign houses; birth time is read as IST.
import * as A from "astronomy-engine";
import { SIGNS } from "./kundli.ts";

const SIGN = SIGNS.map((s) => s[0][0].toUpperCase() + s[0].slice(1)); // Mesh, Vrishabh, …
const DASHA: [string, number][] = [
  ["Ketu", 7], ["Shukra", 20], ["Surya", 6], ["Chandra", 10], ["Mangal", 7], ["Rahu", 18], ["Guru", 16], ["Shani", 19], ["Budh", 17],
];
const YEAR_MS = 365.25 * 864e5;
const norm = (d: number) => ((d % 360) + 360) % 360;

/** Lahiri ayanamsa in degrees (23°51'11" at J2000, ~50.29"/year). */
const ayanamsa = (t: A.AstroTime) => 23.853 + (t.tt / 365.25) * (50.29 / 3600);

function tropical(body: A.Body, t: A.AstroTime): number {
  const ect = A.RotateVector(A.Rotation_EQJ_ECT(t), A.GeoVector(body, t, true));
  return A.SphereFromVector(ect).lon;
}

export type BirthInput = { dob: string; tob?: string | null; lat: number; lon: number };
export type ChartFacts = { moon_sign: string; mahadasha: string; antardasha: string; lagna: string | null; planets: Record<string, string> };

export function computeChart(b: BirthInput, now = new Date()): ChartFacts {
  // Unknown birth time → noon IST (moon sign and dasha stay close; no lagna).
  const time = /^\d{1,2}:\d{2}$/.test(b.tob ?? "") ? b.tob! : "12:00";
  const birth = new Date(`${b.dob}T${time.padStart(5, "0")}:00+05:30`);
  if (Number.isNaN(birth.getTime())) throw new Error("invalid birth date/time");
  const t = A.MakeTime(birth);
  const ay = ayanamsa(t);
  const sid = (trop: number) => norm(trop - ay);
  const fmt = (lon: number) => `${SIGN[Math.floor(lon / 30)]} ${(lon % 30).toFixed(1)}`;

  const bodies: [string, A.Body][] = [
    ["Su", A.Body.Sun], ["Mo", A.Body.Moon], ["Ma", A.Body.Mars], ["Me", A.Body.Mercury],
    ["Ju", A.Body.Jupiter], ["Ve", A.Body.Venus], ["Sa", A.Body.Saturn],
  ];
  const lon: Record<string, number> = {};
  for (const [k, body] of bodies) lon[k] = sid(tropical(body, t));
  const T = t.tt / 36525;
  lon.Ra = sid(125.04452 - 1934.136261 * T); // mean node
  lon.Ke = norm(lon.Ra + 180);

  let lagna: string | null = null;
  if (b.tob && time === b.tob) {
    const ramc = norm((A.SiderealTime(t) + b.lon / 15) * 15) * (Math.PI / 180);
    const eps = 23.4393 * (Math.PI / 180) - (0.013 * T * Math.PI) / 180;
    const phi = b.lat * (Math.PI / 180);
    const asc = norm((Math.atan2(Math.cos(ramc), -(Math.sin(ramc) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps))) * 180) / Math.PI);
    lagna = SIGN[Math.floor(sid(asc) / 30)];
  }

  // Vimshottari: the Moon's nakshatra sets the first dasha and how much of it is left at birth.
  const nak = 360 / 27;
  const n = Math.floor(lon.Mo / nak);
  const done = (lon.Mo % nak) / nak;
  let i = n % 9;
  let start = birth.getTime() - done * DASHA[i][1] * YEAR_MS;
  while (start + DASHA[i][1] * YEAR_MS <= now.getTime()) {
    start += DASHA[i][1] * YEAR_MS;
    i = (i + 1) % 9;
  }
  const md = DASHA[i];
  let j = i;
  let adStart = start;
  while (adStart + ((md[1] * DASHA[j][1]) / 120) * YEAR_MS <= now.getTime()) {
    adStart += ((md[1] * DASHA[j][1]) / 120) * YEAR_MS;
    j = (j + 1) % 9;
  }

  return {
    moon_sign: SIGN[Math.floor(lon.Mo / 30)],
    mahadasha: md[0],
    antardasha: DASHA[j][0],
    lagna,
    planets: Object.fromEntries(Object.entries(lon).map(([k, v]) => [k, fmt(v)])),
  };
}
