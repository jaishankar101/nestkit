import { Inject, Injectable, Logger } from '@nestjs/common'
import { DataSource } from 'typeorm'
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
   * Setup triggers for the given listener discovery result using differential update.
   * Only obsolete triggers are dropped, and new/changed triggers are upserted.
   * This approach minimizes disruption and prevents event loss during reconfiguration.
   * @param discovery The listener discovery result.
   */
  async setupTriggers(discovery: ListenerDiscovery): Promise<void> {
    const existingTriggers = await this.listTriggers()

    // Map of desired triggers: key = "schema.table", value = trigger metadata
    const desiredTriggersMap = new Map<string, TriggerMetadata>()
    discovery.listeners.forEach((listener) => {
      const key = `${listener.schema}.${listener.table}`
      desiredTriggersMap.set(key, {
        table: listener.table,
        schema: listener.schema,
        name: `${this.config.triggerPrefix}_${listener.table.toLowerCase()}`,
        events: listener.events,
        payloadFields: listener.payloadFields,
      })
    })

    // Map of existing triggers: key = "schema.table"
    const existingTriggersMap = new Map<string, TriggerMetadata>()
    existingTriggers.forEach((trigger) => {
      const key = `${trigger.schema}.${trigger.table}`
      existingTriggersMap.set(key, trigger)
    })

    // Calculate diff: B - A (triggers to drop - obsolete ones)
    const triggersToRemove: TriggerMetadata[] = []
    existingTriggersMap.forEach((trigger, key) => {
      if (!desiredTriggersMap.has(key)) {
        triggersToRemove.push(trigger)
      }
    })

    // Calculate triggers to upsert (create or replace)
    const triggersToUpsert: TriggerMetadata[] = Array.from(desiredTriggersMap.values())

    // First, upsert all desired triggers (atomic per trigger using CREATE OR REPLACE)
    // This ensures triggers are always active, preventing event loss
    if (triggersToUpsert.length > 0) {
      await this.createTriggers(triggersToUpsert, discovery.propNameToColumnNames)
    }

    // Then, drop obsolete triggers (safe now since new ones are active)
    if (triggersToRemove.length > 0) {
      await this.dropTriggers(triggersToRemove)
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

  private async dropTriggers(triggers: TriggerMetadata[]): Promise<void> {
    if (!triggers.length) return

    this.logger.log(`Dropping triggers:\n${triggers.map((t) => `${t.schema}.${t.table}.${t.name}`).join(',\n')}`)
    await this.dataSource.query(
      triggers.map((t) => `DROP FUNCTION IF EXISTS ${t.schema}."${t.name}" CASCADE`).join('; ')
    )
  }

  private async createTriggers(
    triggers: TriggerMetadata[],
    propNameToColumnNames: Record<string, Map<string, string>>
  ): Promise<void> {
    if (!triggers.length) return

    this.logger.log(`Upserting triggers:\n${triggers.map((t) => `${t.schema}.${t.table}.${t.name}`).join(',\n')}`)

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

        await this.dataSource.query(`
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
