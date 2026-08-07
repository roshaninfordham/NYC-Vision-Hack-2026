/**
 * Camera-list search for the agent's search_cameras tool — pure and
 * unit-testable.
 *
 * NYC DOT cameras are named by cross-streets ("Broadway @ 42 St"), so a
 * literal landmark query like "Times Square" finds nothing. This search:
 *   - splits the query into terms and matches cameras containing ANY term,
 *   - ranks by how many distinct terms match,
 *   - normalizes common street-name synonyms (Street→St, Avenue→Ave,
 *     Seventh→7, "42nd"→42, ...) on BOTH sides so spelled-out queries
 *     still hit the abbreviated camera names.
 */

export interface SearchableCamera {
  id: string;
  name: string;
  area: string;
}

export interface CameraSearchResult<T extends SearchableCamera> {
  totalMatches: number;
  cameras: T[];
}

/** Small synonym table: query/camera tokens are folded to a canonical form. */
const SYNONYMS: Record<string, string> = {
  street: "st",
  avenue: "ave",
  av: "ave",
  boulevard: "blvd",
  parkway: "pkwy",
  expressway: "expwy",
  expy: "expwy",
  square: "sq",
  place: "pl",
  road: "rd",
  drive: "dr",
  first: "1",
  second: "2",
  third: "3",
  fourth: "4",
  fifth: "5",
  sixth: "6",
  seventh: "7",
  eighth: "8",
  ninth: "9",
  tenth: "10",
  eleventh: "11",
  twelfth: "12",
};

function normalizeToken(tok: string): string {
  const t = tok.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return "";
  const ordinal = /^(\d+)(st|nd|rd|th)$/.exec(t);
  if (ordinal) return ordinal[1]; // "42nd" -> "42"
  return SYNONYMS[t] ?? t;
}

function tokenize(s: string): string[] {
  return s
    .split(/[\s@,/]+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function termMatches(term: string, nameTokens: string[]): boolean {
  const isNumeric = /^\d+$/.test(term);
  return nameTokens.some((tok) =>
    isNumeric ? tok === term : tok === term || tok.startsWith(term)
  );
}

/**
 * Search cameras by free-text query (ANY-term match, ranked by number of
 * matching terms) and/or borough. Empty query matches everything.
 */
export function searchCameras<T extends SearchableCamera>(
  cameras: T[],
  query?: string,
  borough?: string,
  limit = 10
): CameraSearchResult<T> {
  let pool = cameras;
  if (borough && borough.trim()) {
    const b = borough.trim().toLowerCase();
    pool = pool.filter((cam) => cam.area.toLowerCase() === b);
  }

  const terms = [...new Set(tokenize(query ?? ""))];
  if (terms.length === 0) {
    return { totalMatches: pool.length, cameras: pool.slice(0, limit) };
  }

  const scored: { cam: T; score: number }[] = [];
  for (const cam of pool) {
    const nameTokens = tokenize(cam.name);
    const score = terms.filter((t) => termMatches(t, nameTokens)).length;
    if (score > 0) scored.push({ cam, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.cam.name.localeCompare(b.cam.name)
  );
  return {
    totalMatches: scored.length,
    cameras: scored.slice(0, limit).map((s) => s.cam),
  };
}
