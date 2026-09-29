import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmModuleOptions } from '../database/typeorm-options.factory';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { Video } from '../videos/entities/video.entity';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmModuleOptions),
    QueueModule,
    StorageModule,
    // Registers User and Channel, which the Video relation needs in the metadata.
    UsersModule,
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
})
export class WorkerModule {}
