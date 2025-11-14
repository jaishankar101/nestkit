/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test } from '@nestjs/testing'
import { DataSource, QueryRunner } from 'typeorm'
import { PG_PUBSUB_CONFIG } from '../pg-pubsub'
import { PgTriggerService } from './trigger.service'

describe('PgTriggerService', () => {
  let triggerService: PgTriggerService
  let dataSource: {
    query: jest.Mock
    createQueryRunner: jest.Mock
  }
  let mockQueryRunner: {
    connect: jest.Mock
    startTransaction: jest.Mock
    commitTransaction: jest.Mock
    rollbackTransaction: jest.Mock
    release: jest.Mock
    query: jest.Mock
  }
  const config = {
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    triggerPrefix: 'test_prefix',
    triggerSchema: 'public',
    queue: {
      table: 'test_queue',
      schema: 'public',
    },
  }

  beforeEach(async () => {
    // Mock QueryRunner for transaction support
    mockQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    }

    dataSource = {
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        PgTriggerService,
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: PG_PUBSUB_CONFIG,
          useValue: config,
        },
      ],
    }).compile()

    triggerService = moduleRef.get<PgTriggerService>(PgTriggerService)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('setupTriggers', () => {
    it('should setup triggers within a transaction', async () => {
      const mockDiscovery = {
        listeners: [{ table: 'users', schema: 'public', events: ['INSERT'] }],
        propNameToColumnNames: {
          users: new Map([
            ['name', 'name'],
            ['email', 'email'],
          ]),
        },
      }

      // Mock listTriggers to return existing triggers
      dataSource.query.mockResolvedValueOnce([{ name: 'test_prefix_old_table', schema: 'public', table: 'old_table' }])

      await triggerService.setupTriggers(mockDiscovery as any)

      // Verify transaction flow
      expect(dataSource.createQueryRunner).toHaveBeenCalled()
      expect(mockQueryRunner.connect).toHaveBeenCalled()
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled()
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled()
      expect(mockQueryRunner.release).toHaveBeenCalled()
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled()
    })

    it('should rollback transaction on error', async () => {
      const mockDiscovery = {
        listeners: [{ table: 'users', schema: 'public', events: ['INSERT'] }],
        propNameToColumnNames: {
          users: new Map([
            ['name', 'name'],
            ['email', 'email'],
          ]),
        },
      }

      // Simulate an error during trigger creation
      mockQueryRunner.query.mockRejectedValueOnce(new Error('Database error'))

      await expect(triggerService.setupTriggers(mockDiscovery as any)).rejects.toThrow('Database error')

      // Verify rollback was called
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled()
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled()
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled()
      expect(mockQueryRunner.release).toHaveBeenCalled()
    })

    it('should list, drop, and create triggers in correct order', async () => {
      const callOrder: string[] = []

      dataSource.query.mockImplementation(async () => {
        callOrder.push('listTriggers')
        return []
      })

      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        if (sql.includes('DROP FUNCTION')) {
          callOrder.push('dropTriggers')
        } else if (sql.includes('CREATE OR REPLACE FUNCTION')) {
          callOrder.push('createTriggers')
        }
        return []
      })

      const mockDiscovery = {
        listeners: [{ table: 'users', schema: 'public', events: ['INSERT'] }],
        propNameToColumnNames: {
          users: new Map([
            ['name', 'name'],
            ['email', 'email'],
          ]),
        },
      }

      await triggerService.setupTriggers(mockDiscovery as any)

      // Verify execution order
      expect(callOrder[0]).toBe('listTriggers')
      expect(callOrder.includes('createTriggers')).toBe(true)
    })

    it('should ensure queryRunner is released even if commit fails', async () => {
      const mockDiscovery = {
        listeners: [{ table: 'users', schema: 'public', events: ['INSERT'] }],
        propNameToColumnNames: {
          users: new Map([
            ['name', 'name'],
            ['email', 'email'],
          ]),
        },
      }

      // Simulate commit failure
      mockQueryRunner.commitTransaction.mockRejectedValueOnce(new Error('Commit failed'))

      await expect(triggerService.setupTriggers(mockDiscovery as any)).rejects.toThrow('Commit failed')

      // Verify release was still called
      expect(mockQueryRunner.release).toHaveBeenCalled()
    })

    it('should handle atomic transaction - no events lost between drop and create', async () => {
      // This test verifies that drop and create happen in the same transaction
      const mockDiscovery = {
        listeners: [{ table: 'users', schema: 'public', events: ['INSERT', 'UPDATE', 'DELETE'] }],
        propNameToColumnNames: {
          users: new Map([
            ['name', 'name'],
            ['email', 'email'],
          ]),
        },
      }

      dataSource.query.mockResolvedValueOnce([{ name: 'test_prefix_users', schema: 'public', table: 'users' }])

      let transactionStarted = false
      let transactionCommitted = false

      mockQueryRunner.startTransaction.mockImplementation(async () => {
        transactionStarted = true
      })

      mockQueryRunner.query.mockImplementation(async () => {
        // Verify we're inside a transaction when executing queries
        expect(transactionStarted).toBe(true)
        expect(transactionCommitted).toBe(false)
        return []
      })

      mockQueryRunner.commitTransaction.mockImplementation(async () => {
        transactionCommitted = true
      })

      await triggerService.setupTriggers(mockDiscovery as any)

      expect(transactionStarted).toBe(true)
      expect(transactionCommitted).toBe(true)
    })
  })

  describe('listTriggers', () => {
    it('should list existing triggers with the configured prefix', async () => {
      const mockTriggers = [
        { name: 'test_prefix_users', schema: 'public', table: 'users' },
        { name: 'test_prefix_posts', schema: 'public', table: 'posts' },
      ]
      dataSource.query.mockResolvedValueOnce(mockTriggers)

      const result = await (triggerService as any).listTriggers()

      expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining(`DISTINCT(trigger_name) as name`))
      expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining(`trigger_name LIKE 'test_prefix_%'`))
      expect(result).toEqual(mockTriggers)
    })

    it('should return empty array when no triggers exist', async () => {
      dataSource.query.mockResolvedValueOnce(null)

      const result = await (triggerService as any).listTriggers()

      expect(result).toEqual([])
    })
  })

  describe('dropTriggers', () => {
    it('should drop specified triggers using queryRunner when provided', async () => {
      const triggers = [
        { name: 'test_prefix_users', schema: 'public', table: 'users' },
        { name: 'test_prefix_posts', schema: 'public', table: 'posts' },
      ]

      await (triggerService as any).dropTriggers(triggers, mockQueryRunner)

      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(`DROP FUNCTION IF EXISTS public."test_prefix_users" CASCADE`)
      )
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(`DROP FUNCTION IF EXISTS public."test_prefix_posts" CASCADE`)
      )
      expect(dataSource.query).not.toHaveBeenCalled()
    })

    it('should drop specified triggers using dataSource when queryRunner not provided', async () => {
      const triggers = [{ name: 'test_prefix_users', schema: 'public', table: 'users' }]

      await (triggerService as any).dropTriggers(triggers)

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(`DROP FUNCTION IF EXISTS public."test_prefix_users" CASCADE`)
      )
    })

    it('should do nothing if triggers list is empty', async () => {
      await (triggerService as any).dropTriggers([], mockQueryRunner)

      expect(mockQueryRunner.query).not.toHaveBeenCalled()
      expect(dataSource.query).not.toHaveBeenCalled()
    })
  })

  describe('createTriggers', () => {
    it('should create triggers for the provided metadata using queryRunner', async () => {
      const triggers = [
        {
          name: 'test_prefix_users',
          schema: 'public',
          table: 'users',
          events: ['INSERT'],
        },
      ]

      const propNameToColumnNames = {
        users: new Map([
          ['name', 'name'],
          ['email', 'email'],
        ]),
      }

      await (triggerService as any).createTriggers(triggers, propNameToColumnNames, mockQueryRunner)

      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(`CREATE OR REPLACE FUNCTION public."test_prefix_users"()`)
      )
      expect(mockQueryRunner.query).toHaveBeenCalledWith(expect.stringContaining(`CREATE TRIGGER test_prefix_users`))
      expect(mockQueryRunner.query).toHaveBeenCalledWith(expect.stringContaining(`AFTER INSERT ON "public"."users"`))
    })

    it('should create triggers with multiple events', async () => {
      const triggers = [
        {
          name: 'test_prefix_users',
          schema: 'public',
          table: 'users',
          events: ['INSERT', 'UPDATE', 'DELETE'],
        },
      ]

      const propNameToColumnNames = {
        users: new Map([
          ['name', 'name'],
          ['email', 'email'],
        ]),
      }

      await (triggerService as any).createTriggers(triggers, propNameToColumnNames, mockQueryRunner)

      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(`AFTER INSERT OR UPDATE OR DELETE ON "public"."users"`)
      )
    })

    it('should create triggers with all events when events not specified', async () => {
      const triggers = [
        {
          name: 'test_prefix_users',
          schema: 'public',
          table: 'users',
        },
      ]

      const propNameToColumnNames = {
        users: new Map([
          ['name', 'name'],
          ['email', 'email'],
        ]),
      }

      await (triggerService as any).createTriggers(triggers, propNameToColumnNames, mockQueryRunner)

      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(`AFTER INSERT OR UPDATE OR DELETE ON "public"."users"`)
      )
    })

    it('should create triggers with specific payload fields', async () => {
      const triggers = [
        {
          name: 'test_prefix_users',
          schema: 'public',
          table: 'users',
          events: ['INSERT'],
          payloadFields: ['name'],
        },
      ]

      const propNameToColumnNames = {
        users: new Map([
          ['name', 'name'],
          ['email', 'email'],
        ]),
      }

      await (triggerService as any).createTriggers(triggers, propNameToColumnNames, mockQueryRunner)

      expect(mockQueryRunner.query).toHaveBeenCalledWith(expect.stringContaining(`json_build_object('name', NEW."name")`))
    })

    it('should create triggers using dataSource when queryRunner not provided', async () => {
      const triggers = [
        {
          name: 'test_prefix_users',
          schema: 'public',
          table: 'users',
          events: ['INSERT'],
        },
      ]

      const propNameToColumnNames = {
        users: new Map([
          ['name', 'name'],
          ['email', 'email'],
        ]),
      }

      await (triggerService as any).createTriggers(triggers, propNameToColumnNames)

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(`CREATE OR REPLACE FUNCTION public."test_prefix_users"()`)
      )
    })

    it('should do nothing if triggers list is empty', async () => {
      await (triggerService as any).createTriggers([], {}, mockQueryRunner)

      expect(mockQueryRunner.query).not.toHaveBeenCalled()
      expect(dataSource.query).not.toHaveBeenCalled()
    })

    it('should create triggers with correct queue table reference', async () => {
      const triggers = [
        {
          name: 'test_prefix_users',
          schema: 'public',
          table: 'users',
          events: ['INSERT'],
        },
      ]

      const propNameToColumnNames = {
        users: new Map([
          ['name', 'name'],
          ['email', 'email'],
        ]),
      }

      await (triggerService as any).createTriggers(triggers, propNameToColumnNames, mockQueryRunner)

      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(`INSERT INTO "public"."test_queue"(channel, payload)`)
      )
    })
  })
})
