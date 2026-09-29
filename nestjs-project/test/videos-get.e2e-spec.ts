import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_FAILURE_REASONS } from '../src/videos/videos.constants';

interface VideoBody {
  id: string;
  slug: string;
  title: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  failure_reason: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  container: string | null;
  bitrate: number | null;
  created_at: string;
  updated_at: string;
}

interface ErrorBody {
  statusCode: number;
  error: string;
}

describe('videos-get', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let videoId: string;
  let counter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await abortOpenUploads();
    await app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    ownerToken = await registerConfirmAndLogin(
      `videos_get_owner_${++counter}@example.com`,
    );
    otherToken = await registerConfirmAndLogin(
      `videos_get_other_${counter}@example.com`,
    );
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1000,
      })
      .expect(201);
    videoId = (res.body as { id: string }).id;
  });

  async function abortOpenUploads(): Promise<void> {
    for (const video of await videoRepository.find()) {
      const key = storage.originalKey(video.id);
      if (video.upload_id) {
        await storage.abortMultipartUpload(key, video.upload_id);
      }
      await storage.deleteObject(key);
    }
  }

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const password = 'password123';
    let confirmationToken = '';
    jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, token: string) => {
        confirmationToken = token;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  // 1. GET /videos/{id} (SI-03.8)

  it('returns-fresh-draft-with-null-metadata', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = res.body as VideoBody;
    expect(body.id).toBe(videoId);
    expect(typeof body.slug).toBe('string');
    expect(body.title).toBe('clip');
    expect(body.original_filename).toBe('clip.mp4');
    expect(body.mime_type).toBe('video/mp4');
    expect(body.size_bytes).toBe(1000);
    expect(body.status).toBe('draft');
    expect(body.failure_reason).toBeNull();
    expect(body.duration_seconds).toBeNull();
    expect(body.width).toBeNull();
    expect(body.height).toBeNull();
    expect(body.video_codec).toBeNull();
    expect(body.audio_codec).toBeNull();
    expect(body.container).toBeNull();
    expect(body.bitrate).toBeNull();
    expect(new Date(body.created_at).toISOString()).toBe(body.created_at);
    expect(new Date(body.updated_at).toISOString()).toBe(body.updated_at);
  });

  it('returns-failure-reason-for-failed-video', async () => {
    await videoRepository.update(videoId, {
      status: VideoStatus.FAILED,
      failure_reason: VIDEO_FAILURE_REASONS.UNSUPPORTED_FORMAT,
    });

    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = res.body as VideoBody;
    expect(body.status).toBe('failed');
    expect(body.failure_reason).toBe('UNSUPPORTED_FORMAT');
  });

  it('hides-video-from-other-channel', async () => {
    const fromOther = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const unknown = await request(app.getHttpServer())
      .get(`/videos/${randomUUID()}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    expect((unknown.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('requires-authentication', async () => {
    await request(app.getHttpServer()).get(`/videos/${videoId}`).expect(401);
  });

  it('rejects-non-uuid-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/videos/nao-e-uuid')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });
});
