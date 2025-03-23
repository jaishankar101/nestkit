/**
 * Helper method to convert a string to a number for advisory locks
 * @param str The string to convert to a number
 * @returns The number representation of the string
 */
export const hashStringToInt = (str: string): number => {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash) % 2147483647 // Ensure positive value within PostgreSQL integer range
}
