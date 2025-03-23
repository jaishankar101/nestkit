import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { PgPubSubModule } from '@cisstech/nestjs-pg-pubsub'
import { User } from './entities/user.entity'
import { Notification } from './entities/notification.entity'
import { UserService } from './services/user.service'
import { NotificationService } from './services/notification.service'
import { UserController } from './controllers/user.controller'
import { NotificationController } from './controllers/notification.controller'
import { NotificationChangeListener } from './listeners/notification-change.listener'
import { WebsocketGateway } from './gateways/websocket.gateway'

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Notification]),
    PgPubSubModule.forRoot({
      databaseUrl: process.env['DATABASE_URL'] as string,
    }),
  ],
  controllers: [UserController, NotificationController],
  providers: [UserService, NotificationService, WebsocketGateway, NotificationChangeListener],
})
export class PubSubSampleModule {}
