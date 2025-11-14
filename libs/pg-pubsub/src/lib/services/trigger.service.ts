import { Inject, Injectable, Logger } from '@nestjs/common'
import { DataSource, QueryRunner } from 'typeorm'
import {
  PG_PUBSUB_CONFIG,
  PG_PUBSUB_QUEUE_SCHEMA,
  PG_PUBSUB_QUEUE_TABLE,
  PgPubSubConfig,
  PgTableChangeType,
} from '../pg-pubsub'
import { ListenerDiscovery } from './listener-discovery.service'

export interface TriggerMetadata {
  name: string
  table: string
  schema: string
  events?: PgTableChangeType[]
  payloadFields?: string[]
}

export interface TableListener {
  events?: PgTableChangeType[]
  table: string
  schema: string
  payloadFields?: string[]
}

/**
 * Service responsible for managing PostgreSQL triggers.
 */
@Injectable()
export class PgTriggerService {
  private readonly logger = new Logger(PgTriggerService.name)

  constructor(
    private readonly dataSource: DataSource,
    @Inject(PG_PUBSUB_CONFIG) private readonly config: PgPubSubConfig
  ) {}

  /**
   * Setup triggers for the given listener discovery result.
   * All existing pubsub triggers in the database will be dropped before creating new ones.
   * This operation is performed atomically within a single transaction to prevent event loss.
   * @param discovery The listener discovery result.
   */
  async setupTriggers(discovery: ListenerDiscovery): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      const triggers = await this.listTriggers()

      await this.dropTriggers(triggers, queryRunner)

      await this.createTriggers(
        discovery.listeners.map<TriggerMetadata>((listener) => ({
          table: listener.table,
          schema: listener.schema,
          name: `${this.config.triggerPrefix}_${listener.table.toLowerCase()}`,
          events: listener.events,
          payloadFields: listener.payloadFields,
        })),
        discovery.propNameToColumnNames,
        queryRunner
      )

      await queryRunner.commitTransaction()
    } catch (error) {
      await queryRunner.rollbackTransaction()
      throw error
    } finally {
      await queryRunner.release()
    }
  }

  private async listTriggers(): Promise<TriggerMetadata[]> {
    const triggers = await this.dataSource.query<TriggerMetadata[]>(`
      SELECT
        DISTINCT(trigger_name) as name,
        trigger_schema as schema,
        event_object_table as table
      FROM information_schema.triggers
      WHERE trigger_name LIKE '${this.config.triggerPrefix}_%'
    `)
    return triggers ?? []
  }

  private async dropTriggers(triggers: TriggerMetadata[], queryRunner?: QueryRunner): Promise<void> {
    if (!triggers.length) return

    this.logger.log(`Dropping triggers:\n${triggers.map((t) => `${t.schema}.${t.table}.${t.name}`).join(',\n')}`)

    const executor = queryRunner || this.dataSource
    await executor.query(
      triggers.map((t) => `DROP FUNCTION IF EXISTS ${t.schema}."${t.name}" CASCADE`).join('; ')
    )
  }

  private async createTriggers(
    triggers: TriggerMetadata[],
    propNameToColumnNames: Record<string, Map<string, string>>,
    queryRunner?: QueryRunner
  ): Promise<void> {
    if (!triggers.length) return

    this.logger.log(`Creating triggers:\n${triggers.map((t) => `${t.schema}.${t.table}.${t.name}`).join(',\n')}`)

    const executor = queryRunner || this.dataSource

    await Promise.all(
      triggers.map(async (t) => {
        const table = `"${t.schema}"."${t.table}"`
        const payloadFields = t.payloadFields
        const columns = propNameToColumnNames[t.table]

        const buildJson = (alias: string) => {
          if (!payloadFields?.length) {
            return `row_to_json(${alias})`
          }

          const selects = payloadFields
            .map((field) => `'${columns.get(field)}', ${alias}."${columns.get(field)}"`)
            .join(', ')

          return `json_build_object(${selects})`
        }

        const events = t.events?.length ? t.events : ['INSERT', 'UPDATE', 'DELETE']

        await executor.query(`
          -- Create the trigger function
          CREATE OR REPLACE FUNCTION ${t.schema}."${t.name}"()
          RETURNS TRIGGER
          AS $BODY$
          DECLARE
            payload JSON;
            inserted_id INTEGER;
          BEGIN
            IF (TG_OP = 'DELETE') THEN
              payload := json_build_object(
                'id', gen_random_uuid(),
                'event', TG_OP,
                'schema', TG_TABLE_SCHEMA,
                'table', TG_TABLE_NAME,
                'data', ${buildJson('OLD')}
              );
            ELSIF (TG_OP = 'UPDATE') THEN
              payload := json_build_object(
                'id', gen_random_uuid(),
                'event', TG_OP,
                'schema', TG_TABLE_SCHEMA,
                'table', TG_TABLE_NAME,
                'data', json_build_object(
                  'new', ${buildJson('NEW')},
                  'old', ${buildJson('OLD')}
                )
              );
            ELSE
              payload := json_build_object(
                'id', gen_random_uuid(),
                'event', TG_OP,
                'schema', TG_TABLE_SCHEMA,
                'table', TG_TABLE_NAME,
                'data', ${buildJson('NEW')}
              );
            END IF;

            -- Insert into queue table and get the inserted ID
            INSERT INTO "${this.config.queue?.schema ?? PG_PUBSUB_QUEUE_SCHEMA}"."${
              this.config.queue?.table ?? PG_PUBSUB_QUEUE_TABLE
            }"(channel, payload)
            VALUES ('${this.config.triggerPrefix}', payload)
            RETURNING id INTO inserted_id;

            -- Send notification with just the message ID
            PERFORM pg_notify('${this.config.triggerPrefix}', inserted_id::text);

            RETURN NEW;
          END;
          $BODY$
          LANGUAGE plpgsql;

          -- Drop the trigger if it already exists
          DROP TRIGGER IF EXISTS ${t.name} ON ${table};

          -- Create the trigger
          CREATE TRIGGER ${t.name}
          AFTER ${events.join(' OR ')} ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${t.schema}."${t.name}"();
        `)
      })
    )
  }
}
