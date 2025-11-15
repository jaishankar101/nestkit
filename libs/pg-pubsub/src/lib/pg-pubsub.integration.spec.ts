import { INestApplication } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm'
import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm'
import {
  PgPubSubModule,
  PgPubSubService,
  PgTableChangeListener,
  PgTableChanges,
  RegisterPgTableChangeListener,
} from '..'
// eslint-disable-next-line @nx/enforce-module-boundaries
import { createTestDatabase } from '@cisstech/testing'
import { DataSource } from 'typeorm'
import { MessageStatus, PgTableChangeErrorHandler } from './pg-pubsub'
import { QueueService } from './services'

// Test entity
@Entity('test_users')
class TestUser {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  name!: string

  @Column()
  email!: string
}

// Test listener
@RegisterPgTableChangeListener(TestUser)
class TestUserListener implements PgTableChangeListener<TestUser> {
  public processedChanges: PgTableChanges<TestUser>[] = []
  public processingDelay = 0
  public shouldFail = false

  async process(changes: PgTableChanges<TestUser>, onError: PgTableChangeErrorHandler): Promise<void> {
    if (this.processingDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.processingDelay))
    }

    if (this.shouldFail) {
      onError(changes.all.map((change) => change.id))
      return
    }

    this.processedChanges.push(changes)
  }
}

describe('PgPubSub Integration', () => {
  let app: INestApplication
  let moduleRef: TestingModule
  let dataSource: DataSource
  let pgPubSubService: PgPubSubService
  let queueService: QueueService
  let testListener: TestUserListener
  let userRepository: Repository<TestUser>

  beforeAll(async () => {
    const testDbUrl = await createTestDatabase()

    // Create module
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: testDbUrl,
          entities: [TestUser],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([TestUser]),
        PgPubSubModule.forRoot({
          databaseUrl: testDbUrl,
          triggerPrefix: 'test_pubsub',
          queue: {
            table: 'test_pg_pubsub_queue',
            maxRetries: 3,
          },
        }),
      ],
      providers: [TestUserListener],
    }).compile()

    app = moduleRef.createNestApplication()
    await app.init()

    // Get services
    dataSource = app.get(DataSource)
    pgPubSubService = app.get(PgPubSubService)
    queueService = app.get(QueueService)
    testListener = app.get(TestUserListener)
    userRepository = app.get(getRepositoryToken(TestUser))

    // Make sure PG-PubSub is ready
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }, 30000)

  afterAll(async () => {
    await app.close()
  }, 10000)

  beforeEach(async () => {
    testListener.processedChanges = []
    testListener.processingDelay = 0
    testListener.shouldFail = false
  })

  describe('Basic CRUD operations', () => {
    it('should detect insert operations', async () => {
      // Insert test user
      await userRepository.save({
        name: 'Test User',
        email: 'test@example.com',
      })

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Verify listener was called
      expect(testListener.processedChanges.length).toBe(1)
      expect(testListener.processedChanges[0].INSERT.length).toBe(1)
      expect(testListener.processedChanges[0].INSERT[0].data.name).toBe('Test User')
    })

    it('should detect update operations', async () => {
      // Insert test user
      const user = await userRepository.save({
        name: 'Test User',
        email: 'test@example.com',
      })

      // Wait for processing the insert
      await new Promise((resolve) => setTimeout(resolve, 1000))

      testListener.processedChanges = [] // Reset processed changes

      // Update user
      await userRepository.update(user.id, {
        name: 'Updated User',
      })

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Verify listener was called
      expect(testListener.processedChanges.length).toBe(1)
      expect(testListener.processedChanges[0].UPDATE.length).toBe(1)
      expect(testListener.processedChanges[0].UPDATE[0].data.new.name).toBe('Updated User')
      expect(testListener.processedChanges[0].UPDATE[0].data.old.name).toBe('Test User')
    })

    it('should detect delete operations', async () => {
      // Insert test user
      const user = await userRepository.save({
        name: 'Test User',
        email: 'test@example.com',
      })

      // Wait for processing the insert
      await new Promise((resolve) => setTimeout(resolve, 1000))

      testListener.processedChanges = [] // Reset processed changes

      // Delete user
      await userRepository.delete(user.id)

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Verify listener was called
      expect(testListener.processedChanges.length).toBe(1)
      expect(testListener.processedChanges[0].DELETE.length).toBe(1)
      expect(testListener.processedChanges[0].DELETE[0].data.name).toBe('Test User')
    })

    it('should include metadata in all operation types', async () => {
      // Insert test user
      const user = await userRepository.save({
        name: 'Metadata All Ops User',
        email: 'metadata-all@example.com',
      })

      // Wait for processing the insert
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Check INSERT metadata
      const insertChanges = testListener.processedChanges[0]
      expect(insertChanges.INSERT[0]._metadata).toBeDefined()
      expect(insertChanges.INSERT[0]._metadata?.retry_count).toBe(0)
      expect(insertChanges.INSERT[0]._metadata?.created_at).toBeInstanceOf(Date)

      testListener.processedChanges = [] // Reset

      // Update user
      await userRepository.update(user.id, { name: 'Updated Name' })
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Check UPDATE metadata
      const updateChanges = testListener.processedChanges[0]
      expect(updateChanges.UPDATE[0]._metadata).toBeDefined()
      expect(updateChanges.UPDATE[0]._metadata?.retry_count).toBe(0)
      expect(updateChanges.UPDATE[0]._metadata?.created_at).toBeInstanceOf(Date)

      testListener.processedChanges = [] // Reset

      // Delete user
      await userRepository.delete(user.id)
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Check DELETE metadata
      const deleteChanges = testListener.processedChanges[0]
      expect(deleteChanges.DELETE[0]._metadata).toBeDefined()
      expect(deleteChanges.DELETE[0]._metadata?.retry_count).toBe(0)
      expect(deleteChanges.DELETE[0]._metadata?.created_at).toBeInstanceOf(Date)
    })
  })

  describe('Concurrency', () => {
    it('should handle multiple concurrent updates', async () => {
      // Create 10 users
      const users = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          userRepository.save({
            name: `User ${i}`,
            email: `user${i}@example.com`,
          })
        )
      )

      // Wait for processing the inserts
      await new Promise((resolve) => setTimeout(resolve, 1000))
      testListener.processedChanges = [] // Reset processed changes

      // Set a processing delay to simulate slow processing
      testListener.processingDelay = 100

      // Update all users concurrently
      await Promise.all(
        users.map((user, i) =>
          userRepository.update(user.id, {
            name: `Updated User ${i}`,
          })
        )
      )

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Verify all updates were processed
      const totalUpdates = testListener.processedChanges.reduce((sum, change) => sum + change.UPDATE.length, 0)
      expect(totalUpdates).toBe(10)
    })

    it('should maintain message order during processing', async () => {
      // Create a user
      const user = await userRepository.save({
        name: 'Order Test User',
        email: 'order@example.com',
      })

      // Wait for processing the insert
      await new Promise((resolve) => setTimeout(resolve, 1000))

      testListener.processedChanges = [] // Reset processed changes

      // Set a processing delay to simulate slow processing
      testListener.processingDelay = 150

      // Make 5 sequential updates
      for (let i = 1; i <= 5; i++) {
        await userRepository.update(user.id, {
          name: `Update ${i}`,
        })
        // Don't wait between updates to test ordering
      }

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Get all processed names in order
      const processedNames = testListener.processedChanges
        .flatMap((change) => change.UPDATE)
        .map((update) => update.data.new.name)

      // The first processed update should be "Update 1"
      expect(processedNames[0]).toBe('Update 1')
      // The last processed update should be "Update 5"
      expect(processedNames[processedNames.length - 1]).toBe('Update 5')
    })

    it('should handle failed processing and retries', async () => {
      // Create a spy on markAsFailed
      const markAsFailedSpy = jest.spyOn(queueService, 'markAsFailed')

      // Set listener to fail
      testListener.shouldFail = true

      // Create a user
      await userRepository.save({
        name: 'Failure Test User',
        email: 'failure@example.com',
      })

      // Wait for processing attempt
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Verify the message was marked as failed
      expect(markAsFailedSpy).toHaveBeenCalled()

      // Verify no successful processing occurred
      expect(testListener.processedChanges.length).toBe(0)

      // Manually check the queue to verify the message status
      const queueResult = await dataSource.query(`
        SELECT * FROM test_pg_pubsub_queue
        WHERE status = '${MessageStatus.FAILED}'
      `)

      expect(queueResult.length).toBe(1)
      expect(queueResult[0].retry_count).toBe(1)

      // Reset spy
      markAsFailedSpy.mockRestore()
    })

    it('should process messages when listener comes back online', async () => {
      // Pause the service
      await pgPubSubService.pause()

      // Create several users while service is paused
      await Promise.all([
        userRepository.save({
          name: 'Offline User 1',
          email: 'offline1@example.com',
        }),
        userRepository.save({
          name: 'Offline User 2',
          email: 'offline2@example.com',
        }),
      ])

      // Verify messages are in queue but not processed
      const queueResult = await dataSource.query(`
        SELECT COUNT(*) as count FROM test_pg_pubsub_queue WHERE status = '${MessageStatus.PENDING}'
      `)

      expect(Number(queueResult[0].count)).toBe(2)
      expect(testListener.processedChanges.length).toBe(0)

      // Resume the service
      await pgPubSubService.resume()

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Verify messages were processed
      expect(testListener.processedChanges.length).toBeGreaterThan(0)

      // Check that all messages were processed
      const processedCount = testListener.processedChanges.reduce((sum, change) => sum + change.all.length, 0)
      expect(processedCount).toBe(2)
    })
  })
})
