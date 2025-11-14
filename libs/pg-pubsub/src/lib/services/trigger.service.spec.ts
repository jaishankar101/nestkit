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
    it('should use differential update: upsert desired triggers then drop obsolete ones', async () => {
      // Mock existing triggers
      const existingTriggers = [
        { name: 'test_prefix_posts', schema: 'public', table: 'posts' },
        { name: 'test_prefix_users', schema: 'public', table: 'users' },
      ]
      const listTriggersSpy = jest.spyOn(triggerService as any, 'listTriggers').mockResolvedValue(existingTriggers)
      const dropTriggersSpy = jest.spyOn(triggerService as any, 'dropTriggers').mockResolvedValue(undefined)
      const createTriggersSpy = jest.spyOn(triggerService as any, 'createTriggers').mockResolvedValue(undefined)

      // New discovery wants users and comments (posts is obsolete)
      const mockDiscovery = {
        listeners: [
          { table: 'users', schema: 'public', events: ['INSERT'] },
          { table: 'comments', schema: 'public', events: ['INSERT', 'UPDATE'] },
        ],
        propNameToColumnNames: {
          users: new Map([['name', 'name']]),
          comments: new Map([['text', 'text']]),
        },
      }

      await triggerService.setupTriggers(mockDiscovery as any)

      expect(listTriggersSpy).toHaveBeenCalled()

      // Verify createTriggers was called first with ALL desired triggers
      expect(createTriggersSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ table: 'users', schema: 'public' }),
          expect.objectContaining({ table: 'comments', schema: 'public' }),
        ]),
        mockDiscovery.propNameToColumnNames
      )

      // Verify dropTriggers was called with ONLY obsolete trigger (posts)
      expect(dropTriggersSpy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ table: 'posts' })])
      )

      // Verify order: create before drop
      expect(createTriggersSpy.mock.invocationCallOrder[0]).toBeLessThan(dropTriggersSpy.mock.invocationCallOrder[0])
    })

    it('should only upsert when no obsolete triggers exist', async () => {
      const existingTriggers = [{ name: 'test_prefix_users', schema: 'public', table: 'users' }]
      jest.spyOn(triggerService as any, 'listTriggers').mockResolvedValue(existingTriggers)
      const dropTriggersSpy = jest.spyOn(triggerService as any, 'dropTriggers').mockResolvedValue(undefined)
      const createTriggersSpy = jest.spyOn(triggerService as any, 'createTriggers').mockResolvedValue(undefined)

      const mockDiscovery = {
        listeners: [
          { table: 'users', schema: 'public', events: ['INSERT'] },
          { table: 'posts', schema: 'public', events: ['INSERT'] },
        ],
        propNameToColumnNames: {
          users: new Map([['name', 'name']]),
          posts: new Map([['title', 'title']]),
        },
      }

      await triggerService.setupTriggers(mockDiscovery as any)

      expect(createTriggersSpy).toHaveBeenCalled()
      expect(dropTriggersSpy).not.toHaveBeenCalled()
    })

    it('should handle empty existing triggers (fresh setup)', async () => {
      jest.spyOn(triggerService as any, 'listTriggers').mockResolvedValue([])
      const dropTriggersSpy = jest.spyOn(triggerService as any, 'dropTriggers').mockResolvedValue(undefined)
      const createTriggersSpy = jest.spyOn(triggerService as any, 'createTriggers').mockResolvedValue(undefined)

      const mockDiscovery = {
        listeners: [{ table: 'users', schema: 'public', events: ['INSERT'] }],
        propNameToColumnNames: {
          users: new Map([['name', 'name']]),
        },
      }

      await triggerService.setupTriggers(mockDiscovery as any)

      expect(createTriggersSpy).toHaveBeenCalled()
      expect(dropTriggersSpy).not.toHaveBeenCalled()
    })

    it('should drop all triggers when no listeners provided', async () => {
      const existingTriggers = [
        { name: 'test_prefix_users', schema: 'public', table: 'users' },
        { name: 'test_prefix_posts', schema: 'public', table: 'posts' },
      ]
      jest.spyOn(triggerService as any, 'listTriggers').mockResolvedValue(existingTriggers)
      const dropTriggersSpy = jest.spyOn(triggerService as any, 'dropTriggers').mockResolvedValue(undefined)
      const createTriggersSpy = jest.spyOn(triggerService as any, 'createTriggers').mockResolvedValue(undefined)

      const mockDiscovery = {
        listeners: [],
        propNameToColumnNames: {},
      }

      await triggerService.setupTriggers(mockDiscovery as any)

      expect(createTriggersSpy).not.toHaveBeenCalled()
      expect(dropTriggersSpy).toHaveBeenCalledWith(existingTriggers)
    })

    it('should handle schema differences correctly', async () => {
      const existingTriggers = [
        { name: 'test_prefix_users', schema: 'public', table: 'users' },
        { name: 'test_prefix_users', schema: 'private', table: 'users' },
      ]
      jest.spyOn(triggerService as any, 'listTriggers').mockResolvedValue(existingTriggers)
      const dropTriggersSpy = jest.spyOn(triggerService as any, 'dropTriggers').mockResolvedValue(undefined)
      const createTriggersSpy = jest.spyOn(triggerService as any, 'createTriggers').mockResolvedValue(undefined)

      // Only want public.users
      const mockDiscovery = {
        listeners: [{ table: 'users', schema: 'public', events: ['INSERT'] }],
        propNameToColumnNames: {
          users: new Map([['name', 'name']]),
        },
      }

      await triggerService.setupTriggers(mockDiscovery as any)

      expect(createTriggersSpy).toHaveBeenCalled()
      // Should drop private.users but not public.users
      expect(dropTriggersSpy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ schema: 'private', table: 'users' })])
      )
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
