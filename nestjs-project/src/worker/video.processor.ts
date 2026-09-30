import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Repository } from 'typeorm';
import {
  CLEANUP_STALE_UPLOADS_JOB,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { classifyProbe, findVideoStream } from '../videos/video-format';
import { VideoProcessingFailure } from '../videos/video-processing-failure';
import type { ProcessVideoJobData } from '../videos/video-processing.queue';
import { VideoUploadCleanupService } from '../videos/video-upload-cleanup.service';
import { VIDEO_FAILURE_REASONS } from '../videos/videos.constants';
import {
  FfmpegService,
  UnrecognizedMediaError,
  type FfprobeOutput,
} from './ffmpeg.service';
import { THUMBNAIL } from './worker.constants';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    private readonly videoUploadCleanupService: VideoUploadCleanupService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    switch (job.name) {
      case PROCESS_VIDEO_JOB:
        return this.processVideo(job.data.videoId);
      case CLEANUP_STALE_UPLOADS_JOB:
        return this.cleanupStaleUploads();
      default:
        throw new UnrecoverableError(`Unknown job name: ${job.name}`);
    }
  }

  // Runs after every failed attempt; only the last one marks the video.
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || job.name !== PROCESS_VIDEO_JOB) return;
    const retriesExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!(error instanceof UnrecoverableError) && !retriesExhausted) return;

    const failureReason =
      error instanceof VideoProcessingFailure
        ? error.failureReason
        : VIDEO_FAILURE_REASONS.PROCESSING_ERROR;
    this.logger.warn(
      `Video ${job.data.videoId} failed (${failureReason}): ${error.message}`,
    );
    try {
      await this.videoRepository.update(
        { id: job.data.videoId, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, failure_reason: failureReason },
      );
    } catch (updateError) {
      // Event handlers run outside the job; rethrowing would be unhandled.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        updateError instanceof Error ? updateError.stack : updateError,
      );
    }
  }

  private async cleanupStaleUploads(): Promise<void> {
    const expired = await this.videoUploadCleanupService.cleanupStaleUploads();
    if (expired > 0) this.logger.log(`Expired ${expired} stale upload(s)`);
  }

  // At-least-once delivery: a video that already left `processing` is skipped.
  private async processVideo(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) return;

    const url = await this.storageService.presignGetObject(
      this.storageService.originalKey(videoId),
    );
    const probe = await this.probe(url);
    const format = classifyProbe(probe);
    const metadata = readMetadata(probe);

    const thumbnail = await this.ffmpegService.extractThumbnail(
      url,
      thumbnailSecond(metadata.duration_seconds),
    );
    await this.storageService.putObject(
      this.storageService.thumbnailKey(videoId),
      thumbnail,
      THUMBNAIL.CONTENT_TYPE,
    );

    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        ...format,
        ...metadata,
        failure_reason: null,
      },
    );
  }

  private async probe(url: string): Promise<FfprobeOutput> {
    try {
      return await this.ffmpegService.probe(url);
    } catch (error) {
      if (error instanceof UnrecognizedMediaError) {
        throw new VideoProcessingFailure(VIDEO_FAILURE_REASONS.NOT_A_VIDEO);
      }
      throw error;
    }
  }
}

type ProbedMetadata = Pick<
  Video,
  'duration_seconds' | 'width' | 'height' | 'bitrate'
>;

function readMetadata(probe: FfprobeOutput): ProbedMetadata {
  const videoStream = findVideoStream(probe);
  return {
    duration_seconds: finiteOrNull(
      Number.parseFloat(probe.format.duration ?? ''),
    ),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    bitrate: finiteOrNull(Number.parseInt(probe.format.bit_rate ?? '', 10)),
  };
}

function thumbnailSecond(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds < THUMBNAIL.MIN_DURATION_SECONDS) {
    return 0;
  }
  return Number((durationSeconds * THUMBNAIL.POSITION_RATIO).toFixed(3));
}

const finiteOrNull = (value: number): number | null =>
  Number.isFinite(value) ? value : null;
