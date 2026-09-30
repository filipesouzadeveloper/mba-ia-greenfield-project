import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  CLEANUP_STALE_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { VideoJobsScheduler } from './video-jobs.scheduler';
import { CLEANUP_STALE_UPLOADS_SCHEDULE } from './worker.constants';

// No worker here: only the scheduler registration in Redis is under test.
async function bootstrap(providers: Provider[]): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
      QueueModule,
      BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    ],
    providers,
  }).compile();
  await module.init();
  return module;
}

describe('VideoJobsScheduler (integration)', () => {
  let queueModule: TestingModule;
  let queue: Queue;
  const workerContexts: TestingModule[] = [];

  beforeAll(async () => {
    queueModule = await bootstrap([]);
    queue = queueModule.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queueModule.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    for (const context of workerContexts.splice(0)) await context.close();
    await queue.obliterate({ force: true });
  });

  async function bootstrapWorker(): Promise<void> {
    workerContexts.push(await bootstrap([VideoJobsScheduler]));
  }

  it('should register the hourly cleanup-stale-uploads scheduler on bootstrap', async () => {
    await bootstrapWorker();

    const scheduler = await queue.getJobScheduler(
      CLEANUP_STALE_UPLOADS_SCHEDULE.SCHEDULER_ID,
    );

    expect(scheduler).toMatchObject({
      name: CLEANUP_STALE_UPLOADS_JOB,
      every: CLEANUP_STALE_UPLOADS_SCHEDULE.EVERY_MS,
    });
  });

  it('should keep exactly one scheduler after two bootstraps', async () => {
    await bootstrapWorker();
    await bootstrapWorker();

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0].key).toBe(CLEANUP_STALE_UPLOADS_SCHEDULE.SCHEDULER_ID);
  });
});
