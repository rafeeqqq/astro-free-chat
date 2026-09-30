// Birth place → coordinates, for the lagna. Free-text places ("Guntur, Andhra Pradesh", "Kanpur UP") are matched to a
// known city first, then to the state's capital. No match → no lagna (the chat shows a Moon chart, like an unknown birth time).
// The result says how precise it was, so the kundli is never presented as more exact than it is.
import { CITIES } from "./cities.ts";

// State / UT → [capital, lat, lon] and the short forms people type.
const STATES: [string[], string, number, number][] = [
  [["andhra pradesh", "ap"], "Amaravati", 16.51, 80.52], [["arunachal pradesh"], "Itanagar", 27.08, 93.61],
  [["assam"], "Guwahati", 26.14, 91.74], [["bihar"], "Patna", 25.59, 85.14], [["chhattisgarh", "cg"], "Raipur", 21.25, 81.63],
  [["goa"], "Panaji", 15.49, 73.83], [["gujarat"], "Ahmedabad", 23.03, 72.58], [["haryana"], "Chandigarh", 30.73, 76.78],
  [["himachal pradesh", "hp"], "Shimla", 31.1, 77.17], [["jharkhand"], "Ranchi", 23.34, 85.31],
  [["karnataka"], "Bengaluru", 12.97, 77.59], [["kerala", "keralam"], "Thiruvananthapuram", 8.52, 76.94],
  [["madhya pradesh", "mp"], "Bhopal", 23.26, 77.41], [["maharashtra"], "Mumbai", 19.08, 72.88],
  [["manipur"], "Imphal", 24.82, 93.94], [["meghalaya"], "Shillong", 25.58, 91.89], [["mizoram"], "Aizawl", 23.73, 92.72],
  [["nagaland"], "Kohima", 25.67, 94.11], [["odisha", "orissa"], "Bhubaneswar", 20.3, 85.82], [["punjab"], "Chandigarh", 30.73, 76.78],
  [["rajasthan"], "Jaipur", 26.91, 75.79], [["sikkim"], "Gangtok", 27.33, 88.61], [["tamil nadu", "tn"], "Chennai", 13.08, 80.27],
  [["telangana", "ts"], "Hyderabad", 17.39, 78.49], [["tripura"], "Agartala", 23.83, 91.28],
  [["uttar pradesh", "up"], "Lucknow", 26.85, 80.95], [["uttarakhand", "uk"], "Dehradun", 30.32, 78.03],
  [["west bengal", "wb"], "Kolkata", 22.57, 88.36], [["delhi", "new delhi", "ncr"], "Delhi", 28.61, 77.21],
  [["jammu and kashmir", "j&k", "jammu & kashmir"], "Srinagar", 34.08, 74.8], [["ladakh"], "Leh", 34.15, 77.58],
  [["puducherry", "pondicherry"], "Puducherry", 11.94, 79.81], [["chandigarh"], "Chandigarh", 30.73, 76.78],
];

// Common alternative spellings of cities in the list.
const ALIASES: Record<string, string> = {
  bangalore: "bengaluru", bombay: "mumbai", calcutta: "kolkata", madras: "chennai", "new delhi": "delhi", gurgaon: "gurugram",
  prayagraj: "allahabad (prayagraj)", allahabad: "allahabad (prayagraj)", trivandrum: "thiruvananthapuram", cochin: "kochi",
  mysore: "mysuru", mangalore: "mangaluru", vizag: "visakhapatnam", benares: "varanasi", banaras: "varanasi", pondicherry: "puducherry",
  calicut: "kozhikode", trichy: "tiruchirappalli", baroda: "vadodara", poona: "pune",
};

export type Place = { lat: number; lon: number; precision: "city" | "state"; matched: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z&() ]+/g, " ").replace(/\s+/g, " ").trim();
const cityIndex = new Map(CITIES.map(([name, lat, lon]) => [norm(name), { name, lat, lon }]));

export function findPlace(raw: string | null | undefined): Place | null {
  const text = norm(raw ?? "");
  if (!text) return null;
  const parts = [text, ...String(raw).split(/[,/|-]/).map(norm)].filter(Boolean);
  for (const p of parts) {
    const key = ALIASES[p] ?? p;
    const c = cityIndex.get(key);
    if (c) return { lat: c.lat, lon: c.lon, precision: "city", matched: c.name };
  }
  // "kanpur nagar", "tenali town": a known city as a whole word inside the text
  for (const [key, c] of cityIndex) {
    const bare = key.replace(/ \(.*\)$/, "");
    if (new RegExp(`\\b${bare.replace(/[()]/g, "")}\\b`).test(text)) return { lat: c.lat, lon: c.lon, precision: "city", matched: c.name };
  }
  for (const [names, capital, lat, lon] of STATES) {
    if (parts.some((p) => names.includes(p)) || names.some((n) => n.length > 3 && new RegExp(`\\b${n.replace("&", "\\&")}\\b`).test(text)))
      return { lat, lon, precision: "state", matched: `${capital} (state capital)` };
  }
  return null;
}
