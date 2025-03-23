import { hashStringToInt } from './pg-pubsub.utils'

describe('pg-pubsub.utils', () => {
  describe('hashStringToInt', () => {
    it('should return a number', () => {
      const result = hashStringToInt('test')
      expect(typeof result).toBe('number')
    })

    it('should return the same number for the same input string', () => {
      const input = 'test-string'
      const result1 = hashStringToInt(input)
      const result2 = hashStringToInt(input)
      expect(result1).toBe(result2)
    })

    it('should return different numbers for different input strings', () => {
      const result1 = hashStringToInt('test1')
      const result2 = hashStringToInt('test2')
      expect(result1).not.toBe(result2)
    })

    it('should return a non-negative number', () => {
      const result = hashStringToInt('test')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should return a number within PostgreSQL integer range', () => {
      const result = hashStringToInt('test')
      expect(result).toBeLessThanOrEqual(2147483647)
    })

    it('should handle empty strings', () => {
      const result = hashStringToInt('')
      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should handle long strings', () => {
      const longString = 'a'.repeat(10000)
      const result = hashStringToInt(longString)
      expect(result).toBeGreaterThanOrEqual(0)
      expect(result).toBeLessThanOrEqual(2147483647)
    })
  })
})
