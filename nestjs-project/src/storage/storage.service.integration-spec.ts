import {
  DeleteBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const streamToBuffer = async (
  stream: AsyncIterable<Uint8Array>,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

describe('StorageService (integration)', () => {
  const originalBucket = process.env.S3_BUCKET;
  const bucket = `streamtube-test-${randomUUID()}`;
  const content = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
  const createdKeys: string[] = [];

  let module: TestingModule;
  let storage: StorageService;
  let client: S3Client;

  beforeAll(async () => {
    process.env.S3_BUCKET = bucket;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    client = module.get(S3_INTERNAL_CLIENT);
    await module.init();
  });

  afterAll(async () => {
    for (const key of createdKeys) await storage.deleteObject(key);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    await module.close();
    process.env.S3_BUCKET = originalBucket;
  });

  const uploadSinglePart = async (
    key: string,
  ): Promise<{ uploadId: string; etag: string }> => {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1);
    const response = await fetch(url, { method: 'PUT', body: content });
    expect(response.status).toBe(200);
    return { uploadId, etag: response.headers.get('etag') ?? '' };
  };

  it('onModuleInit creates the missing bucket and is idempotent on a second run', async () => {
    await expect(
      client.send(new HeadBucketCommand({ Bucket: bucket })),
    ).resolves.toBeDefined();

    await expect(storage.onModuleInit()).resolves.toBeUndefined();
  });

  it('builds original and thumbnail keys under videos/{videoId}/', () => {
    expect(storage.originalKey('abc')).toBe('videos/abc/original');
    expect(storage.thumbnailKey('abc')).toBe('videos/abc/thumbnail.jpg');
  });

  it('lists a part uploaded through the presigned URL, completes it and exposes the object', async () => {
    const key = storage.originalKey(randomUUID());
    createdKeys.push(key);
    const { uploadId, etag } = await uploadSinglePart(key);

    const parts = await storage.listParts(key, uploadId);
    expect(parts).toEqual([{ partNumber: 1, etag, size: content.length }]);

    await storage.completeMultipartUpload(key, uploadId, parts);

    const metadata = await storage.headObject(key);
    expect(metadata.contentLength).toBe(content.length);
    expect(metadata.contentType).toBe('video/mp4');
  });

  it('getObjectStream with a Range returns exactly the requested bytes and ContentRange', async () => {
    const key = storage.originalKey(randomUUID());
    createdKeys.push(key);
    const { uploadId } = await uploadSinglePart(key);
    await storage.completeMultipartUpload(
      key,
      uploadId,
      await storage.listParts(key, uploadId),
    );

    const result = await storage.getObjectStream(key, 'bytes=0-9');
    const bytes = await streamToBuffer(result.body);

    expect(bytes).toEqual(content.subarray(0, 10));
    expect(result.contentLength).toBe(10);
    expect(result.contentRange).toBe(`bytes 0-9/${content.length}`);
  });

  it('abortMultipartUpload does not throw when the upload was already aborted', async () => {
    const key = storage.originalKey(randomUUID());
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await storage.abortMultipartUpload(key, uploadId);

    await expect(
      storage.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
    await expect(storage.listParts(key, uploadId)).rejects.toThrow();
  });
});
