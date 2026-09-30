import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

interface CreatedDraftBody {
  id: string;
  slug: string;
  status: string;
  upload: {
    part_size: number;
    part_count: number;
    expires_at: string;
    parts: { part_number: number; url: string }[];
  };
}

interface ErrorBody {
  statusCode: number;
  error: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_REGEX = /^[A-Za-z0-9_-]{11}$/;

describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let accessToken: string;
  let userEmail: string;
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
    userEmail = `videos_create_${++counter}@example.com`;
    accessToken = await registerConfirmAndLogin(userEmail);
  });

  async function abortOpenUploads(): Promise<void> {
    const drafts = await videoRepository.find();
    for (const video of drafts) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(
          storage.originalKey(video.id),
          video.upload_id,
        );
      }
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

  const validBody = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 150_000_000,
  };

  // 1. POST /videos (SI-03.5)

  it('creates-draft-with-presigned-parts', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(validBody)
      .expect(201);

    const body = res.body as CreatedDraftBody;
    expect(body.status).toBe('draft');
    expect(body.id).toMatch(UUID_REGEX);
    expect(body.slug).toMatch(SLUG_REGEX);
    expect(body.upload.part_size).toBe(67108864);
    expect(body.upload.part_count).toBe(3);
    expect(new Date(body.upload.expires_at).toISOString()).toBe(
      body.upload.expires_at,
    );
    expect(new Date(body.upload.expires_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(body.upload.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    for (const part of body.upload.parts) {
      expect(part.url).toEqual(expect.any(String));
      expect(part.url.length).toBeGreaterThan(0);
    }

    const video = await videoRepository.findOneByOrFail({ id: body.id });
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: userEmail });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    expect(video.status).toBe('draft');
    expect(video.upload_id).toEqual(expect.any(String));
    expect(video.original_filename).toBe('clip.mp4');
    expect(video.title).toBe('clip');
    expect(video.channel_id).toBe(channel.id);

    const put = await fetch(body.upload.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('some video bytes'),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  it('rejects-unsupported-format', async () => {
    const unsupportedMime = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...validBody, content_type: 'video/quicktime', size_bytes: 1000 })
      .expect(422);
    expect((unsupportedMime.body as ErrorBody).error).toBe(
      'UNSUPPORTED_VIDEO_FORMAT',
    );

    const unsupportedExtension = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...validBody, filename: 'clip.mov', size_bytes: 1000 })
      .expect(422);
    expect((unsupportedExtension.body as ErrorBody).error).toBe(
      'UNSUPPORTED_VIDEO_FORMAT',
    );

    expect(await videoRepository.count()).toBe(0);
  });

  it('rejects-video-too-large', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ...validBody, size_bytes: 10737418241 })
      .expect(413);

    expect((res.body as ErrorBody).error).toBe('VIDEO_TOO_LARGE');
    expect(await videoRepository.count()).toBe(0);
  });

  it('rejects-invalid-body', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', content_type: 'video/mp4' })
      .expect(400);

    expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });

  it('requires-authentication', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);

    expect(await videoRepository.count()).toBe(0);
  });
});
