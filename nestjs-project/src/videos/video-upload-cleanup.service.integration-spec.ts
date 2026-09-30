import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
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
import { generateVideoSlug } from './video-slug.util';
import { VideoUploadCleanupService } from './video-upload-cleanup.service';
import {
  VIDEO_FAILURE_REASONS,
  VIDEO_STALE_UPLOAD_HOURS,
} from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const HOUR_MS = 3_600_000;
const NOW = new Date();
const hoursAgo = (hours: number): Date =>
  new Date(NOW.getTime() - hours * HOUR_MS);

describe('VideoUploadCleanupService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let service: VideoUploadCleanupService;
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
    service = new VideoUploadCleanupService(videoRepository, storage);
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const { key, uploadId } of openUploads.splice(0)) {
      await storage.abortMultipartUpload(key, uploadId);
    }
  });

  let counter = 0;
  async function seedVideo(
    createdAt: Date,
    status = VideoStatus.DRAFT,
  ): Promise<Video> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `upload_cleanup_${n}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${n}`,
      nickname: `upload-cleanup-${n}`,
      user_id: user.id,
    });
    const video = await videoRepository.save(
      videoRepository.create({
        slug: generateVideoSlug(),
        channel_id: channel.id,
        title: `clip ${n}`,
        original_filename: 'clip.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
        status,
      }),
    );
    const key = storage.originalKey(video.id);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    openUploads.push({ key, uploadId });
    await videoRepository.update(video.id, {
      upload_id: uploadId,
      created_at: createdAt,
    });
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  function listParts(video: Video) {
    return storage.listParts(
      storage.originalKey(video.id),
      video.upload_id ?? '',
    );
  }

  it('should expire a draft older than the stale window and abort its multipart', async () => {
    const video = await seedVideo(hoursAgo(VIDEO_STALE_UPLOAD_HOURS + 1));

    const expired = await service.cleanupStaleUploads(NOW);

    expect(expired).toBe(1);
    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: VIDEO_FAILURE_REASONS.UPLOAD_EXPIRED,
      upload_id: null,
    });
    await expect(listParts(video)).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('should keep a recent draft and its multipart', async () => {
    const video = await seedVideo(hoursAgo(VIDEO_STALE_UPLOAD_HOURS - 1));

    const expired = await service.cleanupStaleUploads(NOW);

    expect(expired).toBe(0);
    const unchanged = await videoRepository.findOneByOrFail({ id: video.id });
    expect(unchanged.status).toBe(VideoStatus.DRAFT);
    expect(unchanged.upload_id).toBe(video.upload_id);
    await expect(listParts(video)).resolves.toEqual([]);
  });

  it('should leave an old video that is already processing untouched', async () => {
    const video = await seedVideo(
      hoursAgo(VIDEO_STALE_UPLOAD_HOURS + 1),
      VideoStatus.PROCESSING,
    );

    const expired = await service.cleanupStaleUploads(NOW);

    expect(expired).toBe(0);
    const unchanged = await videoRepository.findOneByOrFail({ id: video.id });
    expect(unchanged.status).toBe(VideoStatus.PROCESSING);
    expect(unchanged.upload_id).toBe(video.upload_id);
  });

  it('should expire a stale draft whose multipart no longer exists', async () => {
    const video = await seedVideo(hoursAgo(VIDEO_STALE_UPLOAD_HOURS + 1));
    await storage.abortMultipartUpload(
      storage.originalKey(video.id),
      video.upload_id ?? '',
    );

    const expired = await service.cleanupStaleUploads(NOW);

    expect(expired).toBe(1);
    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
  });

  it('should keep expiring the other drafts when one abort fails', async () => {
    const broken = await seedVideo(hoursAgo(VIDEO_STALE_UPLOAD_HOURS + 2));
    const healthy = await seedVideo(hoursAgo(VIDEO_STALE_UPLOAD_HOURS + 1));
    // Oldest first: the first abort is the broken draft's.
    jest
      .spyOn(storage, 'abortMultipartUpload')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    const expired = await service.cleanupStaleUploads(NOW);

    expect(expired).toBe(1);
    const brokenAfter = await videoRepository.findOneByOrFail({
      id: broken.id,
    });
    const healthyAfter = await videoRepository.findOneByOrFail({
      id: healthy.id,
    });
    expect(brokenAfter.status).toBe(VideoStatus.DRAFT);
    expect(brokenAfter.upload_id).toBe(broken.upload_id);
    expect(healthyAfter.status).toBe(VideoStatus.FAILED);
  });
});
