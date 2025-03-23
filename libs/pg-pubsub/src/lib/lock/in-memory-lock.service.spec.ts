import { Test, TestingModule } from '@nestjs/testing'
import { InMemoryLockService } from './in-memory-lock.service'

describe('InMemoryLockService', () => {
  let service: InMemoryLockService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InMemoryLockService],
    }).compile()

    service = module.get<InMemoryLockService>(InMemoryLockService)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  it('should acquire a lock and execute onAccept', async () => {
    const onAccept = jest.fn()
    const onReject = jest.fn()

    await service.tryLock({
      key: 'test-key',
      duration: 1000,
      onAccept,
      onReject,
    })

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()
  })

  it('should reject concurrent lock attempts for the same key', async () => {
    const onAccept1 = jest.fn()
    const onReject1 = jest.fn()
    const onAccept2 = jest.fn()
    const onReject2 = jest.fn()

    // Acquire the first lock
    await service.tryLock({
      key: 'test-key',
      duration: 1000,
      onAccept: onAccept1,
      onReject: onReject1,
    })

    // Try to acquire the second lock while the first one is still active
    await service.tryLock({
      key: 'test-key',
      duration: 1000,
      onAccept: onAccept2,
      onReject: onReject2,
    })

    expect(onAccept1).toHaveBeenCalledTimes(1)
    expect(onReject1).not.toHaveBeenCalled()
    expect(onAccept2).not.toHaveBeenCalled()
    expect(onReject2).toHaveBeenCalledTimes(1)
  })

  it('should respect the lock duration', async () => {
    const onAccept1 = jest.fn()
    const onReject1 = jest.fn()
    const onAccept2 = jest.fn()
    const onReject2 = jest.fn()

    // Acquire the first lock with a short duration
    await service.tryLock({
      key: 'test-key',
      duration: 100, // Very short duration
      onAccept: onAccept1,
      onReject: onReject1,
    })

    // Wait for the lock to expire
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Try to acquire the second lock after the first one has expired
    await service.tryLock({
      key: 'test-key',
      duration: 100,
      onAccept: onAccept2,
      onReject: onReject2,
    })

    expect(onAccept1).toHaveBeenCalledTimes(1)
    expect(onReject1).not.toHaveBeenCalled()
    expect(onAccept2).toHaveBeenCalledTimes(1)
    expect(onReject2).not.toHaveBeenCalled()
  })
})
