/**
 * A jsonb[] argument as a Postgres array literal. PostgREST reads a JSON array inside a JSON array
 * as a further dimension: [["a"], ["b"]] is a 2-by-1 array and p_values[1] is NULL, and [["a"], 7]
 * answers 22P02. A literal keeps each value one element.
 */
export function jsonbArrayLiteral(values: readonly unknown[]): string {
  const elements = values.map((value) => {
    if (value === null || value === undefined) return 'NULL'
    return `"${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  })
  return `{${elements.join(',')}}`
}
