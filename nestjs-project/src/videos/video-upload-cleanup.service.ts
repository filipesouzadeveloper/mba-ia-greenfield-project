import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, type Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VIDEO_FAILURE_REASONS,
  VIDEO_STALE_UPLOAD_HOURS,
} from './videos.constants';

const HOUR_MS = 3_600_000;

@Injectable()
export class VideoUploadCleanupService {
  private readonly logger = new Logger(VideoUploadCleanupService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  // Returns how many drafts were expired.
  async cleanupStaleUploads(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - VIDEO_STALE_UPLOAD_HOURS * HOUR_MS);
    const staleDrafts = await this.videoRepository.find({
      select: { id: true, upload_id: true },
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
      order: { created_at: 'ASC' },
    });

    let expired = 0;
    for (const video of staleDrafts) {
      try {
        if (await this.expireDraft(video)) expired++;
      } catch (error) {
        // Scheduled job: one broken upload must not block the others.
        this.logger.error(
          `Could not expire stale upload of video ${video.id}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
    return expired;
  }

  private async expireDraft(
    video: Pick<Video, 'id' | 'upload_id'>,
  ): Promise<boolean> {
    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        this.storageService.originalKey(video.id),
        video.upload_id,
      );
    }
    // Conditional: a draft completed meanwhile is already `processing`.
    const result = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.FAILED,
        failure_reason: VIDEO_FAILURE_REASONS.UPLOAD_EXPIRED,
        upload_id: null,
      },
    );
    return (result.affected ?? 0) > 0;
  }
}
