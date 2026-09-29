import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { basename, extname } from 'path';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidVideoStatusException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type {
  CreatedVideoDraftDto,
  UploadPartUrlDto,
} from './dto/created-video-draft.dto';
import type { UploadStatusDto } from './dto/upload-status.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { assertUploadFormat } from './video-format';
import { generateVideoSlug } from './video-slug.util';
import {
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
  VIDEO_PART_URL_EXPIRES_SECONDS,
  VIDEO_SLUG_MAX_RETRIES,
  VIDEO_SLUG_UNIQUE_CONSTRAINT,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';

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
