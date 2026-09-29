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
import { binaryParser } from '../src/test/binary-parser';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateThumbnailFixture } from '../src/test/video-fixtures';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface CreatedDraftBody {
  id: string;
  slug: string;
}

interface ErrorBody {
  statusCode: number;
  error: string;
}

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);

describe('videos-thumbnail', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let jpeg: Buffer;
  let video: CreatedDraftBody;
  let counter = 0;

  beforeAll(async () => {
    jpeg = await generateThumbnailFixture();

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
    await cleanUpStorage();
    await app.close();
  });

  beforeEach(async () => {
    await cleanUpStorage();
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const token = await registerConfirmAndLogin(
      `videos_thumbnail_${++counter}@example.com`,
    );
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1000,
      })
      .expect(201);
    video = res.body as CreatedDraftBody;
  });

  async function cleanUpStorage(): Promise<void> {
    for (const existing of await videoRepository.find()) {
      if (existing.upload_id) {
        await storage.abortMultipartUpload(
          storage.originalKey(existing.id),
          existing.upload_id,
        );
      }
      await storage.deleteObject(storage.thumbnailKey(existing.id));
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

  // The worker path to `ready` is covered by video.processor.integration-spec.
  async function markReadyWithThumbnail(): Promise<void> {
    await storage.putObject(storage.thumbnailKey(video.id), jpeg, 'image/jpeg');
    await videoRepository.update(video.id, {
      status: VideoStatus.READY,
      container: 'mp4',
    });
  }

  // 1. GET /videos/{slug}/thumbnail (SI-03.11)

  it('serves-jpeg-for-ready-video', async () => {
    await markReadyWithThumbnail();

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/thumbnail`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-length']).toBe(String(jpeg.length));
    const body = res.body as Buffer;
    expect(body.subarray(0, JPEG_SOI.length).equals(JPEG_SOI)).toBe(true);
    expect(body.equals(jpeg)).toBe(true);
  });

  it('returns-not-found-when-not-ready', async () => {
    const draft = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/thumbnail`)
      .expect(404);
    expect((draft.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await videoRepository.update(video.id, { status: VideoStatus.FAILED });
    const failed = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/thumbnail`)
      .expect(404);
    expect((failed.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const unknown = await request(app.getHttpServer())
      .get('/videos/inexistente1/thumbnail')
      .expect(404);
    expect((unknown.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });
});
