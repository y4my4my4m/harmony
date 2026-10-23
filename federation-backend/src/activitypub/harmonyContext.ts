/**
 * Harmony's term prefix. Activities carry it inline in `@context`: a context URL is
 * dereferenced by JSON-LD processors, so its host would define Harmony's terms.
 */
export const HARMONY_NS = 'https://mony.lol/ns#';

export const HARMONY_CONTEXT = { harmony: HARMONY_NS } as const;
