import { Test } from '@nestjs/testing'
import { DataSource } from 'typeorm'
import { PgLockService } from './pg-lock.service'

jest.mock('../pg-pubsub.utils', () => ({
  hashStringToInt: jest.fn().mockReturnValue(12345),
}))

describe('PgLockService', () => {
  let pgLockService: PgLockService
  let dataSource: {
    query: jest.Mock
  }

  beforeEach(async () => {
    dataSource = {
      query: jest.fn(),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        PgLockService,
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile()

    pgLockService = moduleRef.get<PgLockService>(PgLockService)
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  describe('tryLock', () => {
    it('should execute callback when lock is acquired', async () => {
      dataSource.query.mockResolvedValueOnce([{ acquired: true }])

      const onAccept = jest.fn()
      const onReject = jest.fn()

      await pgLockService.tryLock({
        key: 'test-lock',
        duration: 1000,
        onAccept,
        onReject,
      })

      expect(dataSource.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) as acquired', [12345])
      expect(onAccept).toHaveBeenCalled()
      expect(onReject).not.toHaveBeenCalled()
    })

    it('should release lock after duration', async () => {
      jest.useFakeTimers()
      dataSource.query.mockResolvedValueOnce([{ acquired: true }])

      const onAccept = jest.fn()

      await pgLockService.tryLock({
        key: 'test-lock',
        duration: 1000,
        onAccept,
      })

      // Verify lock is acquired
      expect(onAccept).toHaveBeenCalled()

      // Fast-forward time
      jest.advanceTimersByTime(1100)

      // Verify lock is released
      expect(dataSource.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [12345])
    })

    it('should call onReject when lock cannot be acquired', async () => {
      dataSource.query.mockResolvedValueOnce([{ acquired: false }])

      const onAccept = jest.fn()
      const onReject = jest.fn()

      await pgLockService.tryLock({
        key: 'test-lock',
        duration: 1000,
        onAccept,
        onReject,
      })

      expect(onAccept).not.toHaveBeenCalled()
      expect(onReject).toHaveBeenCalled()
    })

    it('should call onReject when an error occurs', async () => {
      const error = new Error('Database error')
      dataSource.query.mockRejectedValueOnce(error)

      const onAccept = jest.fn()
      const onReject = jest.fn()

      await pgLockService.tryLock({
        key: 'test-lock',
        duration: 1000,
        onAccept,
        onReject,
      })

      expect(onAccept).not.toHaveBeenCalled()
      expect(onReject).toHaveBeenCalledWith(error)
    })

    it('should use default duration if not provided', async () => {
      jest.useFakeTimers()
      dataSource.query.mockResolvedValueOnce([{ acquired: true }])

      const onAccept = jest.fn()

      await pgLockService.tryLock({
        key: 'test-lock',
        duration: 0, // Invalid duration
        onAccept,
      })

      // Verify default timeout is used (10 seconds)
      jest.advanceTimersByTime(10100)

      // Verify lock is released after default duration
      expect(dataSource.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [12345])
    })
  })
})
