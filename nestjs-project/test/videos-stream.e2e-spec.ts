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
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { binaryParser } from '../src/test/binary-parser';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateVideoFixture } from '../src/test/video-fixtures';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface CreatedDraftBody {
  id: string;
  slug: string;
  upload: { parts: { part_number: number; url: string }[] };
}

interface ErrorBody {
  statusCode: number;
  error: string;
}

describe('videos-stream', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let fixture: Buffer<ArrayBuffer>;
  let size: number;
  let video: CreatedDraftBody;
  let counter = 0;

  beforeAll(async () => {
    fixture = Buffer.from(await generateVideoFixture('mp4-h264-aac'));
    size = fixture.length;

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
    const token = await registerConfirmAndLogin(
      `videos_stream_${++counter}@example.com`,
    );
    video = await uploadFixture(token);
    // The worker path to `ready` is covered by video.processor.integration-spec.
    await videoRepository.update(video.id, {
      status: VideoStatus.READY,
      container: 'mp4',
    });
  });

  async function cleanUpStorage(): Promise<void> {
    for (const existing of await videoRepository.find()) {
      const key = storage.originalKey(existing.id);
      if (existing.upload_id) {
        await storage.abortMultipartUpload(key, existing.upload_id);
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

  async function uploadFixture(token: string): Promise<CreatedDraftBody> {
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: size,
      })
      .expect(201);
    const draft = created.body as CreatedDraftBody;
    const put = await fetch(draft.upload.parts[0].url, {
      method: 'PUT',
      body: fixture,
    });
    expect(put.status).toBe(200);
    await request(app.getHttpServer())
      .post(`/videos/${draft.id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);
    return draft;
  }

  function getBinary(path: string) {
    return request(app.getHttpServer())
      .get(path)
      .buffer(true)
      .parse(binaryParser);
  }

  // 1. GET /videos/{slug}/stream e /download (SI-03.10)

  it('streams-partial-content-for-range', async () => {
    const res = await getBinary(`/videos/${video.slug}/stream`)
      .set('Range', 'bytes=0-1023')
      .expect(206);

    expect(res.headers['content-range']).toBe(`bytes 0-1023/${size}`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('1024');
    expect(res.headers['content-type']).toBe('video/mp4');
    const body = res.body as Buffer;
    expect(body.length).toBe(1024);
    expect(body.equals(fixture.subarray(0, 1024))).toBe(true);
  });

  it('streams-full-file-without-range', async () => {
    const res = await getBinary(`/videos/${video.slug}/stream`).expect(200);

    expect(res.headers['content-length']).toBe(String(size));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect((res.body as Buffer).equals(fixture)).toBe(true);
  });

  it('rejects-unsatisfiable-range', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .set('Range', `bytes=${size}-`)
      .expect(416);

    expect((res.body as ErrorBody).error).toBe('RANGE_NOT_SATISFIABLE');
    expect(res.headers['content-range']).toBe(`bytes */${size}`);
  });

  it('download-sets-attachment-disposition', async () => {
    const full = await getBinary(`/videos/${video.slug}/download`).expect(200);

    expect(full.headers['content-length']).toBe(String(size));
    const disposition = full.headers['content-disposition'];
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toContain('filename="clip.mp4"');
    expect(disposition).toContain("filename*=UTF-8''clip.mp4");

    const partial = await getBinary(`/videos/${video.slug}/download`)
      .set('Range', 'bytes=0-99')
      .expect(206);

    expect(partial.headers['content-range']).toBe(`bytes 0-99/${size}`);
    expect(partial.headers['content-disposition']).toBe(disposition);
  });

  it('returns-not-found-when-not-ready', async () => {
    await videoRepository.update(video.id, { status: VideoStatus.PROCESSING });
    const processing = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .expect(404);
    expect((processing.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await videoRepository.update(video.id, { status: VideoStatus.DRAFT });
    const draft = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .expect(404);
    expect((draft.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    for (const route of ['stream', 'download']) {
      const unknown = await request(app.getHttpServer())
        .get(`/videos/inexistente1/${route}`)
        .expect(404);
      expect((unknown.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    }
  });
});
