/**
 * Quote a value for safe use inside a PostgREST logical filter tree
 * (`.or(...)` / `.and(...)`).
 *
 * Inside these trees, reserved characters - `,` `.` `(` `)` `:` and whitespace-
 * are part of the filter grammar. A raw attacker-controlled string (e.g. a
 * federated `ap_id`/`url` from an inbox payload) containing any of them can
 * break out of the intended `column.eq.<value>` clause and inject additional
 * filter logic. PostgREST allows escaping this by wrapping the value in double
 * quotes, with `"` and `\` backslash-escaped.
 */
// Escape for embedding inside an already double-quoted PostgREST literal
// (e.g. array containment values like `cs.{"<value>"}`).
export function pgrstEscape(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function pgrstOrValue(value: string): string {
  return `"${pgrstEscape(value)}"`;
}
