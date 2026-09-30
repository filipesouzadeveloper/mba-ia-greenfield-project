import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  CLEANUP_STALE_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { CLEANUP_STALE_UPLOADS_SCHEDULE } from './worker.constants';

@Injectable()
export class VideoJobsScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {}

  // Upsert by a fixed id, so restarting the worker never duplicates it.
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CLEANUP_STALE_UPLOADS_SCHEDULE.SCHEDULER_ID,
      { every: CLEANUP_STALE_UPLOADS_SCHEDULE.EVERY_MS },
      {
        name: CLEANUP_STALE_UPLOADS_JOB,
        opts: {
          removeOnComplete: true,
          removeOnFail: CLEANUP_STALE_UPLOADS_SCHEDULE.KEEP_FAILED_JOBS,
        },
      },
    );
  }
}
