/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test } from '@nestjs/testing'
import { DataSource } from 'typeorm'
import { PG_PUBSUB_CONFIG } from '../pg-pubsub'
import { PgTriggerService } from './trigger.service'

describe('PgTriggerService', () => {
  let triggerService: PgTriggerService
  let dataSource: {
    query: jest.Mock
  }
  const config = {
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    triggerPrefix: 'test_prefix',
    triggerSchema: 'public',
    queue: {
      table: 'test_queue',
    },
  }

  beforeEach(async () => {
    dataSource = {
      query: jest.fn().mockResolvedValue([]),
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
    it('should setup triggers based on discovery result', async () => {
      const listTriggersSpy = jest.spyOn(triggerService as any, 'listTriggers')
      const dropTriggersSpy = jest.spyOn(triggerService as any, 'dropTriggers')
      const createTriggersSpy = jest.spyOn(triggerService as any, 'createTriggers')

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

      expect(listTriggersSpy).toHaveBeenCalled()
      expect(dropTriggersSpy).toHaveBeenCalled()
      expect(createTriggersSpy).toHaveBeenCalled()
    })
  })

  describe('listTriggers', () => {
    it('should list existing triggers', async () => {
      const mockTriggers = [{ name: 'test_prefix_users', schema: 'public', table: 'users' }]
      dataSource.query.mockResolvedValueOnce(mockTriggers)

      const result = await (triggerService as any).listTriggers()

      expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining(`DISTINCT(trigger_name) as name`))
      expect(result).toEqual(mockTriggers)
    })
  })

  describe('dropTriggers', () => {
    it('should drop specified triggers', async () => {
      const triggers = [{ name: 'test_prefix_users', schema: 'public', table: 'users' }]

      await (triggerService as any).dropTriggers(triggers)

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(`DROP FUNCTION IF EXISTS public."test_prefix_users" CASCADE`)
      )
    })

    it('should do nothing if triggers list is empty', async () => {
      await (triggerService as any).dropTriggers([])

      expect(dataSource.query).not.toHaveBeenCalled()
    })
  })

  describe('createTriggers', () => {
    it('should create triggers for the provided metadata', async () => {
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
        // eslint-disable-next-line no-useless-escape
        expect.stringContaining(`CREATE OR REPLACE FUNCTION public.\"test_prefix_users\"()`)
      )
    })

    it('should do nothing if triggers list is empty', async () => {
      await (triggerService as any).createTriggers([], {})

      expect(dataSource.query).not.toHaveBeenCalled()
    })
  })
})
