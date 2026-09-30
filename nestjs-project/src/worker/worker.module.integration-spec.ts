import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('connects to Postgres and exposes the Video repository', async () => {
    const dataSource = app.get(DataSource);
    const videos = app.get<Repository<Video>>(getRepositoryToken(Video));

    expect(dataSource.isInitialized).toBe(true);
    await expect(videos.count()).resolves.toEqual(expect.any(Number));
  });

  it('connects to Redis through the video-processing queue', async () => {
    const queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const redis = await queue.getBackend().client;

    expect(redis.status).toBe('ready');
    expect(queue.opts.prefix).toBe('streamtube-test');
  });

  it('reaches MinIO through StorageService', async () => {
    const storage = app.get(StorageService);

    await expect(
      storage.headObject(`worker-probe/${Date.now()}`),
    ).rejects.toMatchObject({ name: 'NotFound' });
  });

  it('closes the Postgres connection when the context closes', async () => {
    const context = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    const dataSource = context.get(DataSource);

    await context.close();

    expect(dataSource.isInitialized).toBe(false);
  });
});
