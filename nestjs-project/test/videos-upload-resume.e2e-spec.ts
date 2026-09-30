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
import { Video } from '../src/videos/entities/video.entity';

interface UploadPartBody {
  part_number: number;
  url: string;
}

interface CreatedDraftBody {
  id: string;
  upload: { parts: UploadPartBody[] };
}

interface UploadStatusBody {
  id: string;
  status: string;
  upload: {
    part_count: number;
    uploaded_parts: number[];
    parts: UploadPartBody[];
  };
}

interface ErrorBody {
  statusCode: number;
  error: string;
}

describe('videos-upload-resume', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let draft: CreatedDraftBody;
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
      `videos_resume_owner_${++counter}@example.com`,
    );
    otherToken = await registerConfirmAndLogin(
      `videos_resume_other_${counter}@example.com`,
    );
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 150_000_000,
      })
      .expect(201);
    draft = res.body as CreatedDraftBody;
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

  async function putPart(partNumber: number): Promise<void> {
    const part = draft.upload.parts.find((p) => p.part_number === partNumber);
    const res = await fetch(part?.url ?? '', {
      method: 'PUT',
      body: Buffer.from(`bytes of part ${partNumber}`),
    });
    expect(res.status).toBe(200);
  }

  // 1. GET /videos/{id}/upload (SI-03.6)

  it('lists-uploaded-and-resigns-missing-parts', async () => {
    await putPart(1);

    const res = await request(app.getHttpServer())
      .get(`/videos/${draft.id}/upload`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = res.body as UploadStatusBody;
    expect(body.id).toBe(draft.id);
    expect(body.status).toBe('draft');
    expect(body.upload.part_count).toBe(3);
    expect(body.upload.uploaded_parts).toEqual([1]);
    expect(body.upload.parts.map((p) => p.part_number)).toEqual([2, 3]);
    for (const part of body.upload.parts) {
      expect(part.url.length).toBeGreaterThan(0);
    }
  });

  it('returns-empty-parts-when-all-uploaded', async () => {
    await putPart(1);
    await putPart(2);
    await putPart(3);

    const res = await request(app.getHttpServer())
      .get(`/videos/${draft.id}/upload`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = res.body as UploadStatusBody;
    expect(body.upload.uploaded_parts).toEqual([1, 2, 3]);
    expect(body.upload.parts).toEqual([]);
  });

  it('hides-video-from-other-channel', async () => {
    const fromOther = await request(app.getHttpServer())
      .get(`/videos/${draft.id}/upload`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect((fromOther.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const unknown = await request(app.getHttpServer())
      .get(`/videos/${randomUUID()}/upload`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    expect((unknown.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('rejects-video-not-in-draft', async () => {
    const bytes = Buffer.from('the whole video in a single part');
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: bytes.length,
      })
      .expect(201);
    const singlePart = created.body as CreatedDraftBody;
    const put = await fetch(singlePart.upload.parts[0].url, {
      method: 'PUT',
      body: bytes,
    });
    expect(put.status).toBe(200);
    await request(app.getHttpServer())
      .post(`/videos/${singlePart.id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(202);

    const res = await request(app.getHttpServer())
      .get(`/videos/${singlePart.id}/upload`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);

    expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATUS');
  });

  it('rejects-non-uuid-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/videos/nao-e-uuid/upload')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });

  it('requires-authentication', async () => {
    await request(app.getHttpServer())
      .get(`/videos/${draft.id}/upload`)
      .expect(401);
  });
});
