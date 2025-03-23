import { DiscoveryModule } from '@golevelup/nestjs-discovery'
import { DynamicModule, Global, Module } from '@nestjs/common'
import { InMemoryLockService } from './lock'
import {
  PG_PUBSUB_CONFIG,
  PG_PUBSUB_LOCK_SERVICE,
  PG_PUBSUB_TRIGGER_NAME,
  PG_PUBSUB_TRIGGER_SCHEMA,
  PgPubSubConfig,
} from './pg-pubsub'
import { PgPubSubService } from './pg-pubsub.service'

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [PgPubSubService],
  exports: [PgPubSubService],
})
export class PgPubSubModule {
  static forRoot(config: PgPubSubConfig): DynamicModule {
    return {
      module: PgPubSubModule,
      providers: [
        {
          provide: PG_PUBSUB_CONFIG,
          useValue: {
            ...config,
            triggerSchema: (config.triggerSchema || PG_PUBSUB_TRIGGER_SCHEMA).trim(),
            triggerPrefix: (config.triggerPrefix || PG_PUBSUB_TRIGGER_NAME).trim(),
          } satisfies PgPubSubConfig,
        },
        {
          provide: PG_PUBSUB_LOCK_SERVICE,
          useFactory: () => {
            return config.lockService || new InMemoryLockService()
          },
        },
      ],
      exports: [PgPubSubService],
    }
  }
}
