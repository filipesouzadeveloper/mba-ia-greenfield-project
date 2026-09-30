import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface UploadPartBody {
  part_number: number;
  url: string;
}

interface CreatedDraftBody {
  id: string;
  slug: string;
  upload: { parts: UploadPartBody[] };
}

interface CompletedUploadBody {
  id: string;
  slug: string;
  status: string;
}

interface ErrorBody {
  statusCode: number;
  error: string;
}

const SINGLE_PART_BYTES = Buffer.from('the whole video in a single part');

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
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
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await cleanUpStorage();
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanUpStorage();
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    ownerToken = await registerConfirmAndLogin(
      `videos_complete_owner_${++counter}@example.com`,
    );
    otherToken = await registerConfirmAndLogin(
      `videos_complete_other_${counter}@example.com`,
    );
  });

  async function cleanUpStorage(): Promise<void> {
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

  async function createDraft(sizeBytes: number): Promise<CreatedDraftBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    return res.body as CreatedDraftBody;
  }

  async function putPart(
    draft: CreatedDraftBody,
    partNumber: number,
    body: Buffer<ArrayBuffer>,
  ): Promise<void> {
    const part = draft.upload.parts.find((p) => p.part_number === partNumber);
    const res = await fetch(part?.url ?? '', { method: 'PUT', body });
    expect(res.status).toBe(200);
  }

  async function createSinglePartUpload(): Promise<CreatedDraftBody> {
    const draft = await createDraft(SINGLE_PART_BYTES.length);
    await putPart(draft, 1, SINGLE_PART_BYTES);
    return draft;
  }

  function complete(id: string, token: string) {
    return request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`);
  }

  // 1. POST /videos/{id}/upload/complete (SI-03.7)

  it('completes-upload-and-enqueues-processing', async () => {
    const draft = await createSinglePartUpload();

    const res = await complete(draft.id, ownerToken).expect(202);

    expect(res.body as CompletedUploadBody).toEqual({
      id: draft.id,
      slug: draft.slug,
      status: 'processing',
    });
    const head = await storage.headObject(storage.originalKey(draft.id));
    expect(head.contentLength).toBe(SINGLE_PART_BYTES.length);
    const video = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    expect(video.size_bytes).toBe(SINGLE_PART_BYTES.length);
    const job = await queue.getJob(draft.id);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId: draft.id });
  });

  it('rejects-incomplete-upload', async () => {
    const draft = await createDraft(100_000_000);
    await putPart(draft, 1, Buffer.from('only the first part'));

    const res = await complete(draft.id, ownerToken).expect(409);

    expect((res.body as ErrorBody).error).toBe('UPLOAD_INCOMPLETE');
    const video = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).toEqual(expect.any(String));
    expect(await queue.getJob(draft.id)).toBeFalsy();
  });

  it('does-not-requeue-video-already-processing', async () => {
    const draft = await createSinglePartUpload();
    await complete(draft.id, ownerToken).expect(202);

    const res = await complete(draft.id, ownerToken).expect(409);

    expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATUS');
    const jobs = await queue.getJobs();
    expect(jobs.map((job) => job.id)).toEqual([draft.id]);
  });

  it('hides-video-from-other-channel', async () => {
    const draft = await createSinglePartUpload();

    const res = await complete(draft.id, otherToken).expect(404);

    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    const video = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(await queue.getJobs()).toEqual([]);
  });

  it('requires-authentication', async () => {
    const draft = await createSinglePartUpload();

    await request(app.getHttpServer())
      .post(`/videos/${draft.id}/upload/complete`)
      .expect(401);
  });
});
