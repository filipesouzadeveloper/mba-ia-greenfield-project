import { QueryFailedError, type Repository } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import {
  InvalidVideoStatusException,
  UnsupportedVideoFormatException,
  UploadIncompleteException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import type { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import type { VideoProcessingQueue } from './video-processing.queue';
import {
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_PART_SIZE_BYTES,
  VIDEO_SLUG_MAX_RETRIES,
} from './videos.constants';
import { VideosService } from './videos.service';

const USER_ID = 'user-id';
const CHANNEL_ID = 'channel-id';
const VIDEO_ID = 'video-id';
const UPLOAD_ID = 'upload-id';
const ORIGINAL_KEY = `videos/${VIDEO_ID}/original`;

type SavedVideo = Pick<Video, 'id' | 'slug'>;

function makeDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 150_000_000,
    ...overrides,
  };
}

function makeDraftVideo(overrides: Partial<Video> = {}): Partial<Video> {
  return {
    id: VIDEO_ID,
    channel_id: CHANNEL_ID,
    status: VideoStatus.DRAFT,
    size_bytes: 150_000_000,
    upload_id: UPLOAD_ID,
    ...overrides,
  };
}

function makeUploadedPart(partNumber: number) {
  return { partNumber, etag: `"etag-${partNumber}"`, size: 16 };
}

function makeQueryFailedError(constraint: string): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), {
    code: '23505',
    constraint,
  });
}

describe('VideosService', () => {
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findOne: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    originalKey: jest.Mock;
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let videoProcessingQueue: { enqueue: jest.Mock };
  let service: VideosService;

  beforeEach(() => {
    videoRepository = {
      create: jest.fn((fields: Partial<Video>) => fields),
      save: jest.fn((video: Partial<Video>) =>
        Promise.resolve<SavedVideo>({ id: VIDEO_ID, slug: video.slug ?? '' }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(makeDraftVideo()),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };
    storageService = {
      originalKey: jest.fn().mockReturnValue(ORIGINAL_KEY),
      createMultipartUpload: jest.fn().mockResolvedValue(UPLOAD_ID),
      presignUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      ),
      listParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 150_000_000 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    videoProcessingQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    service = new VideosService(
      videoRepository as unknown as Repository<Video>,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
      videoProcessingQueue as unknown as VideoProcessingQueue,
    );
  });

  describe('createDraft', () => {
    it('should reject a declared size above the 10 GiB ceiling before touching the database', async () => {
      await expect(
        service.createDraft(
          USER_ID,
          makeDto({ size_bytes: VIDEO_MAX_SIZE_BYTES + 1 }),
        ),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should accept a declared size exactly at the ceiling', async () => {
      const result = await service.createDraft(
        USER_ID,
        makeDto({ size_bytes: VIDEO_MAX_SIZE_BYTES }),
      );

      expect(result.upload.part_count).toBe(
        VIDEO_MAX_SIZE_BYTES / VIDEO_PART_SIZE_BYTES,
      );
    });

    it('should reject a format outside the allowlist before touching the database', async () => {
      await expect(
        service.createDraft(USER_ID, makeDto({ filename: 'clip.mov' })),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);

      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('should persist the draft in the user channel with a title derived from the filename', async () => {
      await service.createDraft(
        USER_ID,
        makeDto({ filename: 'my.holiday.mp4' }),
      );

      expect(channelsService.findByUserId).toHaveBeenCalledWith(USER_ID);
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: CHANNEL_ID,
          title: 'my.holiday',
          original_filename: 'my.holiday.mp4',
          mime_type: 'video/mp4',
          size_bytes: 150_000_000,
        }),
      );
    });

    it('should truncate the derived title to 100 characters', async () => {
      const longName = 'a'.repeat(150);

      await service.createDraft(
        USER_ID,
        makeDto({ filename: `${longName}.mp4` }),
      );

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'a'.repeat(100) }),
      );
    });

    it('should start the multipart upload, store its id and presign one URL per part', async () => {
      const result = await service.createDraft(USER_ID, makeDto());

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        ORIGINAL_KEY,
        'video/mp4',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        { upload_id: UPLOAD_ID },
      );
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload.part_size).toBe(VIDEO_PART_SIZE_BYTES);
      expect(result.upload.part_count).toBe(3);
      expect(result.upload.parts).toEqual([
        { part_number: 1, url: 'https://storage/part-1' },
        { part_number: 2, url: 'https://storage/part-2' },
        { part_number: 3, url: 'https://storage/part-3' },
      ]);
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        ORIGINAL_KEY,
        UPLOAD_ID,
        3,
      );
    });

    it('should retry with a new slug when the slug collides', async () => {
      videoRepository.save.mockRejectedValueOnce(
        makeQueryFailedError('UQ_videos_slug'),
      );

      await service.createDraft(USER_ID, makeDto());

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [first, second] = videoRepository.create.mock.calls.map(
        ([fields]: [Partial<Video>]) => fields.slug,
      );
      expect(first).not.toBe(second);
    });

    it('should give up after VIDEO_SLUG_MAX_RETRIES slug collisions', async () => {
      videoRepository.save.mockRejectedValue(
        makeQueryFailedError('UQ_videos_slug'),
      );

      await expect(service.createDraft(USER_ID, makeDto())).rejects.toThrow(
        'Video slug conflict',
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(
        VIDEO_SLUG_MAX_RETRIES,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should not retry on a database error unrelated to the slug', async () => {
      const error = makeQueryFailedError('FK_videos_channel_id');
      videoRepository.save.mockRejectedValue(error);

      await expect(service.createDraft(USER_ID, makeDto())).rejects.toBe(error);

      expect(videoRepository.save).toHaveBeenCalledTimes(1);
    });

    it('should remove the draft and rethrow when the multipart upload cannot be started', async () => {
      const error = new Error('storage down');
      storageService.createMultipartUpload.mockRejectedValue(error);

      await expect(service.createDraft(USER_ID, makeDto())).rejects.toBe(error);

      expect(videoRepository.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('getUploadStatus', () => {
    it('should list uploaded parts and presign only the missing ones', async () => {
      storageService.listParts.mockResolvedValue([makeUploadedPart(2)]);

      const result = await service.getUploadStatus(USER_ID, VIDEO_ID);

      expect(storageService.listParts).toHaveBeenCalledWith(
        ORIGINAL_KEY,
        UPLOAD_ID,
      );
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload.part_count).toBe(3);
      expect(result.upload.uploaded_parts).toEqual([2]);
      expect(result.upload.parts).toEqual([
        { part_number: 1, url: 'https://storage/part-1' },
        { part_number: 3, url: 'https://storage/part-3' },
      ]);
    });

    it('should return uploaded parts in ascending order regardless of storage order', async () => {
      storageService.listParts.mockResolvedValue([
        makeUploadedPart(3),
        makeUploadedPart(1),
      ]);

      const result = await service.getUploadStatus(USER_ID, VIDEO_ID);

      expect(result.upload.uploaded_parts).toEqual([1, 3]);
      expect(result.upload.parts.map((p) => p.part_number)).toEqual([2]);
    });

    it('should return no URLs when every part is already stored', async () => {
      storageService.listParts.mockResolvedValue(
        [1, 2, 3].map(makeUploadedPart),
      );

      const result = await service.getUploadStatus(USER_ID, VIDEO_ID);

      expect(result.upload.uploaded_parts).toEqual([1, 2, 3]);
      expect(result.upload.parts).toEqual([]);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should look the video up by id within the user channel', async () => {
      await service.getUploadStatus(USER_ID, VIDEO_ID);

      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { id: VIDEO_ID, channel_id: CHANNEL_ID },
      });
    });

    it('should throw VideoNotFoundException when the video is not in the user channel', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getUploadStatus(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(storageService.listParts).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should throw InvalidVideoStatusException when the video is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(
          makeDraftVideo({ status, upload_id: null }),
        );

        await expect(
          service.getUploadStatus(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);

        expect(storageService.listParts).not.toHaveBeenCalled();
      },
    );
  });

  describe('completeUpload', () => {
    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(
        makeDraftVideo({ slug: 'dQw4w9WgXcQ' }),
      );
      storageService.listParts.mockResolvedValue(
        [3, 1, 2].map(makeUploadedPart),
      );
    });

    it('should complete the multipart with the stored parts, move the video to processing and enqueue it', async () => {
      storageService.headObject.mockResolvedValue({
        contentLength: 149_999_999,
      });

      const result = await service.completeUpload(USER_ID, VIDEO_ID);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        ORIGINAL_KEY,
        UPLOAD_ID,
        expect.arrayContaining([1, 2, 3].map(makeUploadedPart)),
      );
      expect(storageService.headObject).toHaveBeenCalledWith(ORIGINAL_KEY);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.PROCESSING,
          size_bytes: 149_999_999,
          upload_id: null,
        },
      );
      expect(videoProcessingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
      expect(result).toEqual({
        id: VIDEO_ID,
        slug: 'dQw4w9WgXcQ',
        status: VideoStatus.PROCESSING,
      });
    });

    it('should throw UploadIncompleteException when a part is missing', async () => {
      storageService.listParts.mockResolvedValue([1, 3].map(makeUploadedPart));

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(UploadIncompleteException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should ignore stored parts beyond part_count when completing', async () => {
      storageService.listParts.mockResolvedValue(
        [1, 2, 3, 4].map(makeUploadedPart),
      );

      await service.completeUpload(USER_ID, VIDEO_ID);

      const [, , parts] = storageService.completeMultipartUpload.mock
        .calls[0] as [string, string, { partNumber: number }[]];
      expect(parts.map((p) => p.partNumber).sort()).toEqual([1, 2, 3]);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should throw InvalidVideoStatusException without enqueueing when the video is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(
          makeDraftVideo({ status, upload_id: null }),
        );

        await expect(
          service.completeUpload(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);

        expect(storageService.listParts).not.toHaveBeenCalled();
        expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should throw VideoNotFoundException when the video is not in the user channel', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(storageService.listParts).not.toHaveBeenCalled();
    });

    it('should delete the object, fail the video with FILE_TOO_LARGE and not enqueue when the stored object exceeds 10 GiB', async () => {
      storageService.headObject.mockResolvedValue({
        contentLength: VIDEO_MAX_SIZE_BYTES + 1,
      });

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(storageService.deleteObject).toHaveBeenCalledWith(ORIGINAL_KEY);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.DRAFT },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          failure_reason: 'FILE_TOO_LARGE',
          upload_id: null,
        }),
      );
      expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should accept a stored object exactly at the 10 GiB ceiling', async () => {
      storageService.headObject.mockResolvedValue({
        contentLength: VIDEO_MAX_SIZE_BYTES,
      });

      await service.completeUpload(USER_ID, VIDEO_ID);

      expect(storageService.deleteObject).not.toHaveBeenCalled();
      expect(videoProcessingQueue.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should throw InvalidVideoStatusException without enqueueing when a concurrent call already left draft', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);

      expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
    });
  });
});
