import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import queueConfig from '../config/queue.config';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule (integration)', () => {
  let module: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
    }).compile();
    await module.init();
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await module.close();
  });

  it('accepts add and returns the same job through getJob', async () => {
    const jobId = `test-${randomUUID()}`;
    const data = { videoId: randomUUID() };

    await queue.add(PROCESS_VIDEO_JOB, data, { jobId });
    const job = await queue.getJob(jobId);

    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual(data);
    await job?.remove();
  });

  it('stores job keys in Redis under the streamtube-test prefix, not streamtube', async () => {
    const jobId = `test-${randomUUID()}`;
    await queue.add(PROCESS_VIDEO_JOB, { videoId: randomUUID() }, { jobId });
    const redis = await queue.getBackend().client;

    const testJobHash = await redis.hgetall(
      `streamtube-test:${VIDEO_PROCESSING_QUEUE}:${jobId}`,
    );
    const devJobHash = await redis.hgetall(
      `streamtube:${VIDEO_PROCESSING_QUEUE}:${jobId}`,
    );

    expect(queue.opts.prefix).toBe('streamtube-test');
    expect(testJobHash.name).toBe(PROCESS_VIDEO_JOB);
    expect(devJobHash).toEqual({});
    await (await queue.getJob(jobId))?.remove();
  });
});
