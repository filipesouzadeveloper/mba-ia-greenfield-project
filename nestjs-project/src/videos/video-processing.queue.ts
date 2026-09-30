import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Injectable()
export class VideoProcessingQueue {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        jobId: videoId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    );
  }
}
