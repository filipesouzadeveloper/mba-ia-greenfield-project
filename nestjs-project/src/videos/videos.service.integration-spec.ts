import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
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
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);

    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videosService = new VideosService(
      videoRepository,
      new ChannelsService(dataSource),
      storage,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    for (const { key, uploadId } of openUploads.splice(0)) {
      await storage.abortMultipartUpload(key, uploadId);
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
});
