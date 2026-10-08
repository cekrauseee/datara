export function integer(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid stored election count')
  return result
}
export function percentage(numerator: number | null, denominator: number | null) {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : (numerator / denominator) * 100
}
export function measure(numerator: number | null, denominator: number | null, basis: string) {
  return {
    value: percentage(numerator, denominator),
    numerator,
    denominator,
    basis,
    state:
      numerator === null || denominator === null
        ? 'unavailable'
        : denominator === 0
          ? 'undefined'
          : 'available',
  }
}
