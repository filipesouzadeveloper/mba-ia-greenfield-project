import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { basename, extname } from 'path';
import type { Readable } from 'stream';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidVideoStatusException,
  UploadIncompleteException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { CompletedUploadDto } from './dto/completed-upload.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type {
  CreatedVideoDraftDto,
  UploadPartUrlDto,
} from './dto/created-video-draft.dto';
import type { UploadStatusDto } from './dto/upload-status.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  type ByteRange,
  formatByteRange,
  parseRange,
  RANGE_UNSATISFIABLE,
} from './http-range';
import { assertUploadFormat } from './video-format';
import { VideoProcessingQueue } from './video-processing.queue';
import { generateVideoSlug } from './video-slug.util';
import {
  VIDEO_CONTAINER_MIME_TYPES,
  VIDEO_FAILURE_REASONS,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
  VIDEO_PART_URL_EXPIRES_SECONDS,
  VIDEO_SLUG_MAX_RETRIES,
  VIDEO_SLUG_UNIQUE_CONSTRAINT,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';

// `range: null` means the whole object; an unsatisfiable range opens no stream.
export type VideoStream =
  | { video: Video; range: typeof RANGE_UNSATISFIABLE }
  | {
      video: Video;
      range: ByteRange | null;
      body: Readable;
      contentType: string;
    };

const isSlugUniqueViolation = (err: unknown): boolean =>
  err instanceof QueryFailedError &&
  (err as QueryFailedError & { constraint?: unknown }).constraint ===
    VIDEO_SLUG_UNIQUE_CONSTRAINT;

const partCountFor = (sizeBytes: number): number =>
  Math.ceil(sizeBytes / VIDEO_PART_SIZE_BYTES);

const partUrlsExpiresAt = (): string =>
  new Date(Date.now() + VIDEO_PART_URL_EXPIRES_SECONDS * 1000).toISOString();

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoProcessingQueue: VideoProcessingQueue,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedVideoDraftDto> {
    if (dto.size_bytes > VIDEO_MAX_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }
    assertUploadFormat(dto.filename, dto.content_type);

    const channelId = await this.resolveChannelId(userId);
    const video = await this.insertWithUniqueSlug(channelId, dto);
    const key = this.storageService.originalKey(video.id);

    let uploadId: string;
    try {
      uploadId = await this.storageService.createMultipartUpload(
        key,
        dto.content_type,
      );
    } catch (err) {
      // Without a multipart upload the draft can never receive its file.
      await this.videoRepository.delete({ id: video.id });
      throw err;
    }
    await this.videoRepository.update(
      { id: video.id },
      { upload_id: uploadId },
    );

    const partCount = partCountFor(dto.size_bytes);
    const parts = await this.presignParts(
      key,
      uploadId,
      Array.from({ length: partCount }, (_, i) => i + 1),
    );

    return {
      id: video.id,
      slug: video.slug,
      status: VideoStatus.DRAFT,
      upload: {
        part_size: VIDEO_PART_SIZE_BYTES,
        part_count: partCount,
        expires_at: partUrlsExpiresAt(),
        parts,
      },
    };
  }

  async findOwnedOrFail(userId: string, id: string): Promise<Video> {
    const channelId = await this.resolveChannelId(userId);
    const video = await this.videoRepository.findOne({
      where: { id, channel_id: channelId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findReadyBySlugOrFail(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug, status: VideoStatus.READY },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async openStream(
    slug: string,
    rangeHeader: string | undefined,
  ): Promise<VideoStream> {
    const video = await this.findReadyBySlugOrFail(slug);
    const range = parseRange(rangeHeader, video.size_bytes);
    if (range === RANGE_UNSATISFIABLE) {
      return { video, range };
    }

    const { body } = await this.storageService.getObjectStream(
      this.storageService.originalKey(video.id),
      range ? formatByteRange(range) : undefined,
    );
    const contentType =
      (video.container
        ? VIDEO_CONTAINER_MIME_TYPES[video.container]
        : undefined) ?? video.mime_type;
    return { video, range, body, contentType };
  }

  async getUploadStatus(userId: string, id: string): Promise<UploadStatusDto> {
    const video = await this.findOwnedOrFail(userId, id);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStatusException();
    }
    if (!video.upload_id) {
      throw new Error(`Draft video ${video.id} has no multipart upload`);
    }

    const key = this.storageService.originalKey(video.id);
    const partCount = partCountFor(video.size_bytes);
    const stored = new Set(
      (await this.storageService.listParts(key, video.upload_id)).map(
        (part) => part.partNumber,
      ),
    );
    const allParts = Array.from({ length: partCount }, (_, i) => i + 1);
    const uploadedParts = allParts.filter((n) => stored.has(n));
    const missingParts = allParts.filter((n) => !stored.has(n));

    return {
      id: video.id,
      status: VideoStatus.DRAFT,
      upload: {
        part_size: VIDEO_PART_SIZE_BYTES,
        part_count: partCount,
        expires_at: partUrlsExpiresAt(),
        uploaded_parts: uploadedParts,
        parts: await this.presignParts(key, video.upload_id, missingParts),
      },
    };
  }

  async completeUpload(
    userId: string,
    id: string,
  ): Promise<CompletedUploadDto> {
    const video = await this.findOwnedOrFail(userId, id);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStatusException();
    }
    if (!video.upload_id) {
      throw new Error(`Draft video ${video.id} has no multipart upload`);
    }

    const key = this.storageService.originalKey(video.id);
    const storedParts = await this.storageService.listParts(
      key,
      video.upload_id,
    );
    const stored = new Set(storedParts.map((part) => part.partNumber));
    const partCount = partCountFor(video.size_bytes);
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      if (!stored.has(partNumber)) {
        throw new UploadIncompleteException();
      }
    }

    await this.storageService.completeMultipartUpload(
      key,
      video.upload_id,
      storedParts.filter((part) => part.partNumber <= partCount),
    );
    const { contentLength } = await this.storageService.headObject(key);

    if (contentLength > VIDEO_MAX_SIZE_BYTES) {
      await this.storageService.deleteObject(key);
      await this.transitionFromDraft(video.id, {
        status: VideoStatus.FAILED,
        failure_reason: VIDEO_FAILURE_REASONS.FILE_TOO_LARGE,
        upload_id: null,
        size_bytes: contentLength,
      });
      throw new VideoTooLargeException();
    }

    await this.transitionFromDraft(video.id, {
      status: VideoStatus.PROCESSING,
      size_bytes: contentLength,
      upload_id: null,
    });
    await this.videoProcessingQueue.enqueue(video.id);

    return { id: video.id, slug: video.slug, status: VideoStatus.PROCESSING };
  }

  // Conditional on `draft` so a concurrent completion cannot enqueue twice.
  private async transitionFromDraft(
    id: string,
    changes: Partial<Video>,
  ): Promise<void> {
    const { affected } = await this.videoRepository.update(
      { id, status: VideoStatus.DRAFT },
      changes,
    );
    if (!affected) {
      throw new InvalidVideoStatusException();
    }
  }

  private async resolveChannelId(userId: string): Promise<string> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }
    return channel.id;
  }

  private async insertWithUniqueSlug(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<Video> {
    const title = basename(dto.filename, extname(dto.filename)).slice(
      0,
      VIDEO_TITLE_MAX_LENGTH,
    );

    for (let attempt = 0; attempt < VIDEO_SLUG_MAX_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            slug: generateVideoSlug(),
            channel_id: channelId,
            title,
            original_filename: dto.filename,
            mime_type: dto.content_type,
            size_bytes: dto.size_bytes,
          }),
        );
      } catch (err) {
        if (!isSlugUniqueViolation(err)) throw err;
      }
    }

    throw new Error(
      'Video slug conflict could not be resolved after max retries',
    );
  }

  private async presignParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrlDto[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          uploadId,
          partNumber,
        ),
      })),
    );
  }
}
