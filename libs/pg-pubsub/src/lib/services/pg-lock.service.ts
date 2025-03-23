import { Injectable, Logger } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { hashStringToInt } from '../pg-pubsub.utils'

export interface LockOptions {
  /**
   * The key to lock on
   */
  key: string

  /**
   * The duration of the lock in milliseconds.
   * The lock will be hold until this duration expires even if the onAccept callback completes earlier.
   */
  duration: number

  /**
   * Callback to execute when the lock is acquired
   */
  onAccept: () => Promise<void> | void

  /**
   * Optional callback to execute when the lock is rejected
   */
  onReject?: (error?: unknown) => Promise<void> | void
}

/**
 * A PostgreSQL implementation of the lock service using advisory locks.
 * This implementation works across multiple processes as long as they connect to the same PostgreSQL database.
 */
@Injectable()
export class PgLockService {
  private readonly logger = new Logger(PgLockService.name)
  private readonly activeLocks = new Map<string, NodeJS.Timeout>()

  constructor(private readonly dataSource: DataSource) {}

  async tryLock(options: LockOptions): Promise<void> {
    const { key, onAccept, onReject } = options

    // Use default duration of 10 seconds if not provided or invalid
    const duration = options.duration && options.duration > 0 ? options.duration : 10_000
    const lockId = hashStringToInt(key)

    try {
      // Try to acquire an advisory lock
      const lockResult = await this.dataSource.query('SELECT pg_try_advisory_lock($1) as acquired', [lockId])

      if (lockResult[0].acquired) {
        // Schedule the lock release first - this ensures the duration is measured from acquisition time
        const lock = this.activeLocks.get(key)
        if (lock) {
          clearTimeout(lock)
        }

        const timeout = setTimeout(async () => {
          try {
            await this.dataSource.query('SELECT pg_advisory_unlock($1)', [lockId])
            this.activeLocks.delete(key)
          } catch (error) {
            // NOTE: TypeORMError: Driver not Connected is thrown when running tests with Jest
            // This is because the connection is closed before the lock is released at i's a design flaw in the test
            // We can safely ignore this error in the test environment
            this.logger.error(`Failed to release advisory lock for key ${key}`, error)
          }
        }, duration)

        this.activeLocks.set(key, timeout)

        // Now proceed with the operation
        await onAccept()

        return
      }

      // We didn't get the lock, another instance is holding it
      await onReject?.()
    } catch (error) {
      // If there's an error acquiring or releasing the lock, call onReject
      await onReject?.(error)
    }
  }
}
