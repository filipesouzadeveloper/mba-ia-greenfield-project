import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  UploadIncompleteException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingQueue } from './video-processing.queue';
import { VIDEO_PART_SIZE_BYTES } from './videos.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let videosService: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let queue: Queue;
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        StorageModule,
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingQueue],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));

    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videosService = new VideosService(
      videoRepository,
      new ChannelsService(dataSource),
      storage,
      module.get(VideoProcessingQueue),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    for (const { key, uploadId } of openUploads.splice(0)) {
      await storage.abortMultipartUpload(key, uploadId);
      await storage.deleteObject(key);
    }
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videos-svc-${n}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  async function createDraft(userId: string, sizeBytes: number) {
    const result = await videosService.createDraft(userId, {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: sizeBytes,
    });
    const video = await videoRepository.findOneByOrFail({ id: result.id });
    openUploads.push({
      key: storage.originalKey(video.id),
      uploadId: video.upload_id ?? '',
    });
    return { result, video };
  }

  describe('createDraft', () => {
    it('should persist a draft with the multipart upload id in the user channel', async () => {
      const { user, channel } = await createUserWithChannel();

      const { result, video } = await createDraft(user.id, 150_000_000);

      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.channel_id).toBe(channel.id);
      expect(video.slug).toBe(result.slug);
      expect(video.upload_id).toEqual(expect.any(String));
      expect(video.size_bytes).toBe(150_000_000);
      expect(video.title).toBe('clip');
    });

    it.each([
      [1, 1],
      [VIDEO_PART_SIZE_BYTES, 1],
      [VIDEO_PART_SIZE_BYTES + 1, 2],
      [150_000_000, 3],
    ])(
      'should return part_count coherent with size_bytes (%i bytes → %i parts)',
      async (sizeBytes, expectedParts) => {
        const { user } = await createUserWithChannel();

        const { result } = await createDraft(user.id, sizeBytes);

        expect(result.upload.part_count).toBe(expectedParts);
        expect(result.upload.parts.map((p) => p.part_number)).toEqual(
          Array.from({ length: expectedParts }, (_, i) => i + 1),
        );
      },
    );

    it('should return part URLs that accept a PUT into the multipart upload', async () => {
      const { user } = await createUserWithChannel();
      const { result, video } = await createDraft(user.id, 150_000_000);

      const response = await fetch(result.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.from('some video bytes'),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toBeTruthy();
      const parts = await storage.listParts(
        storage.originalKey(video.id),
        video.upload_id ?? '',
      );
      expect(parts.map((p) => p.partNumber)).toEqual([1]);
    });
  });

  describe('getUploadStatus', () => {
    it('should report the stored part and presign only the missing one', async () => {
      const { user } = await createUserWithChannel();
      const { result } = await createDraft(user.id, VIDEO_PART_SIZE_BYTES + 1);
      const put = await fetch(result.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.from('some video bytes'),
      });
      expect(put.status).toBe(200);

      const status = await videosService.getUploadStatus(user.id, result.id);

      expect(status.upload.part_count).toBe(2);
      expect(status.upload.uploaded_parts).toEqual([1]);
      expect(status.upload.parts.map((p) => p.part_number)).toEqual([2]);
      const resumed = await fetch(status.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.from('more video bytes'),
      });
      expect(resumed.status).toBe(200);
    });

    it('should hide a video that belongs to another channel', async () => {
      const { user: owner } = await createUserWithChannel();
      const { user: other } = await createUserWithChannel();
      const { result } = await createDraft(owner.id, 1);

      await expect(
        videosService.getUploadStatus(other.id, result.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('completeUpload', () => {
    it('should assemble the object, move the video to processing and enqueue a job keyed by the video id', async () => {
      const { user } = await createUserWithChannel();
      const bytes = Buffer.from('the whole video in a single part');
      const { result } = await createDraft(user.id, bytes.length);
      const put = await fetch(result.upload.parts[0].url, {
        method: 'PUT',
        body: bytes,
      });
      expect(put.status).toBe(200);

      const completed = await videosService.completeUpload(user.id, result.id);

      expect(completed.status).toBe(VideoStatus.PROCESSING);
      const head = await storage.headObject(storage.originalKey(result.id));
      expect(head.contentLength).toBe(bytes.length);
      const video = await videoRepository.findOneByOrFail({ id: result.id });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.upload_id).toBeNull();
      expect(video.size_bytes).toBe(bytes.length);
      const job = await queue.getJob(result.id);
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.data).toEqual({ videoId: result.id });
      expect(job?.opts.attempts).toBe(3);
    });

    it('should keep the video as draft and enqueue nothing when a part is missing', async () => {
      const { user } = await createUserWithChannel();
      const { result } = await createDraft(user.id, VIDEO_PART_SIZE_BYTES + 1);
      await fetch(result.upload.parts[0].url, {
        method: 'PUT',
        body: Buffer.from('only the first part'),
      });

      await expect(
        videosService.completeUpload(user.id, result.id),
      ).rejects.toBeInstanceOf(UploadIncompleteException);

      const video = await videoRepository.findOneByOrFail({ id: result.id });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.upload_id).toEqual(expect.any(String));
      expect(await queue.getJob(result.id)).toBeFalsy();
    });
  });
});
