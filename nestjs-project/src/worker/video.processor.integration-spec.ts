import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job, Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  generateVideoFixture,
  type VideoFixture,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  VideoProcessingQueue,
  type ProcessVideoJobData,
} from '../videos/video-processing.queue';
import { generateVideoSlug } from '../videos/video-slug.util';
import { VIDEO_FAILURE_REASONS } from '../videos/videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';
import { WorkerModule } from './worker.module';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const WAIT_TIMEOUT_MS = 30_000;

describe('VideoProcessor (integration)', () => {
  let app: INestApplicationContext;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue<ProcessVideoJobData>;
  let processor: VideoProcessor;
  let videoProcessingQueue: VideoProcessingQueue;
  const storedVideoIds: string[] = [];

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    dataSource = app.get(DataSource);
    videoRepository = app.get<Repository<Video>>(getRepositoryToken(Video));
    storage = app.get(StorageService);
    queue = app.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    processor = app.get(VideoProcessor);
    // The API's producer, so the jobs carry the real options (attempts, backoff).
    videoProcessingQueue = new VideoProcessingQueue(queue);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app?.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const id of storedVideoIds.splice(0)) {
      await storage.deleteObject(storage.originalKey(id));
      await storage.deleteObject(storage.thumbnailKey(id));
    }
  });

  let counter = 0;
  async function seedVideo(
    fixture: VideoFixture,
    status = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `video_processor_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `video-processor-${n}`,
      user_id: user.id,
    });
    const bytes = await generateVideoFixture(fixture);
    const video = await videoRepository.save(
      videoRepository.create({
        slug: generateVideoSlug(),
        channel_id: channel.id,
        title: fixture,
        original_filename: `${fixture}.mp4`,
        mime_type: 'video/mp4',
        size_bytes: bytes.length,
        status,
      }),
    );
    storedVideoIds.push(video.id);
    await storage.putObject(storage.originalKey(video.id), bytes, 'video/mp4');
    return video;
  }

  // Resolves once the job finishes for good: completed, or failed with no
  // retry left.
  function waitForJobToSettle(jobId: string): Promise<Job> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Job ${jobId} did not settle`));
      }, WAIT_TIMEOUT_MS);
      const onCompleted = (job: Job) => {
        if (job.id === jobId) settle(job);
      };
      const onFailed = (job: Job | undefined) => {
        if (job?.id === jobId && job.finishedOn) settle(job);
      };
      const settle = (job: Job) => {
        cleanup();
        resolve(job);
      };
      const cleanup = () => {
        clearTimeout(timer);
        processor.worker.off('completed', onCompleted);
        processor.worker.off('failed', onFailed);
      };
      processor.worker.on('completed', onCompleted);
      processor.worker.on('failed', onFailed);
    });
  }

  // The processor's own `failed` handler updates the row asynchronously.
  async function waitForStatus(
    id: string,
    status: VideoStatus,
  ): Promise<Video> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const video = await videoRepository.findOneByOrFail({ id });
      if (video.status === status) return video;
      if (Date.now() > deadline) {
        throw new Error(`Video ${id} stayed ${video.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function runJob(video: Video): Promise<Job> {
    const settled = waitForJobToSettle(video.id);
    await videoProcessingQueue.enqueue(video.id);
    return settled;
  }

  it('should move a valid H.264/AAC MP4 to ready with its metadata and thumbnail', async () => {
    const video = await seedVideo('mp4-h264-aac');

    await runJob(video);

    const processed = await waitForStatus(video.id, VideoStatus.READY);
    expect(processed.duration_seconds).toBeCloseTo(2, 1);
    expect(processed).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      container: 'mp4',
      failure_reason: null,
    });
    expect(processed.bitrate).toBeGreaterThan(0);
    const thumbnail = await storage.getObjectStream(
      storage.thumbnailKey(video.id),
    );
    expect(thumbnail.contentType).toBe('image/jpeg');
    const bytes = Buffer.concat(await thumbnail.body.toArray());
    expect(bytes.subarray(0, 3)).toEqual(JPEG_MAGIC);
  });

  it('should move a VP9/Opus WebM to ready as webm', async () => {
    const video = await seedVideo('webm-vp9-opus');

    await runJob(video);

    const processed = await waitForStatus(video.id, VideoStatus.READY);
    expect(processed).toMatchObject({
      video_codec: 'vp9',
      audio_codec: 'opus',
      container: 'webm',
    });
  });

  it('should fail an MP4 with mpeg4 video as UNSUPPORTED_FORMAT on the first attempt', async () => {
    const video = await seedVideo('mp4-mpeg4');

    const job = await runJob(video);

    expect(job.attemptsMade).toBe(1);
    const processed = await waitForStatus(video.id, VideoStatus.FAILED);
    expect(processed.failure_reason).toBe(
      VIDEO_FAILURE_REASONS.UNSUPPORTED_FORMAT,
    );
    expect(processed.video_codec).toBeNull();
  });

  it('should fail a file that is not a video as NOT_A_VIDEO without retrying', async () => {
    const video = await seedVideo('text');

    const job = await runJob(video);

    expect(job.attemptsMade).toBe(1);
    const processed = await waitForStatus(video.id, VideoStatus.FAILED);
    expect(processed.failure_reason).toBe(VIDEO_FAILURE_REASONS.NOT_A_VIDEO);
  });

  it('should leave a video that is no longer processing untouched', async () => {
    const video = await seedVideo('mp4-h264-aac', VideoStatus.READY);
    const probe = jest.spyOn(app.get(FfmpegService), 'probe');

    await runJob(video);

    expect(probe).not.toHaveBeenCalled();
    const unchanged = await videoRepository.findOneByOrFail({ id: video.id });
    expect(unchanged.status).toBe(VideoStatus.READY);
    expect(unchanged.updated_at).toEqual(video.updated_at);
    await expect(
      storage.headObject(storage.thumbnailKey(video.id)),
    ).rejects.toMatchObject({ name: 'NotFound' });
  });

  it('should fail as PROCESSING_ERROR only after a transient error persists through every attempt', async () => {
    const video = await seedVideo('mp4-h264-aac');
    const probe = jest
      .spyOn(app.get(FfmpegService), 'probe')
      .mockRejectedValue(new Error('storage connection reset'));

    const job = await runJob(video);

    expect(job.attemptsMade).toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
    const processed = await waitForStatus(video.id, VideoStatus.FAILED);
    expect(processed.failure_reason).toBe(
      VIDEO_FAILURE_REASONS.PROCESSING_ERROR,
    );
  });
});
