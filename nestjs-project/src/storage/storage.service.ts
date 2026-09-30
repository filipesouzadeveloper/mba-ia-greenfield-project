import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'stream';
import storageConfig from '../config/storage.config';
import {
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
  STORAGE_KEYS,
  STORAGE_PRESIGN_TTL_SECONDS,
} from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface ObjectMetadata {
  contentLength: number;
  contentType?: string;
  etag?: string;
}

export interface ObjectStream {
  body: Readable;
  contentLength: number;
  contentRange?: string;
  contentType?: string;
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly bucket: string;

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.internalClient.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: this.bucket }),
      );
    }
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  originalKey(videoId: string): string {
    return `${STORAGE_KEYS.PREFIX}/${videoId}/${STORAGE_KEYS.ORIGINAL}`;
  }

  thumbnailKey(videoId: string): string {
    return `${STORAGE_KEYS.PREFIX}/${videoId}/${STORAGE_KEYS.THUMBNAIL}`;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for key ${key}`);
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: STORAGE_PRESIGN_TTL_SECONDS.UPLOAD_PART },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;

    do {
      const response = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );
      for (const part of response.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          etag: part.ETag ?? '',
          size: part.Size ?? 0,
        });
      }
      partNumberMarker = response.IsTruncated
        ? response.NextPartNumberMarker
        : undefined;
    } while (partNumberMarker);

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const completedParts: CompletedPart[] = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }));

    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!isNoSuchUpload(error)) throw error;
    }
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    const response = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
      etag: response.ETag,
    };
  }

  async getObjectStream(key: string, range?: string): Promise<ObjectStream> {
    const response = await this.internalClient.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
    );
    if (!response.Body) {
      throw new Error(`Storage returned no body for key ${key}`);
    }
    return {
      body: response.Body as Readable,
      contentLength: response.ContentLength ?? 0,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async presignGetObject(key: string): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: STORAGE_PRESIGN_TTL_SECONDS.GET_OBJECT },
    );
  }
}

const errorName = (error: unknown): string | undefined =>
  error instanceof Error ? error.name : undefined;

const httpStatus = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;

const isNotFound = (error: unknown): boolean =>
  errorName(error) === 'NotFound' ||
  errorName(error) === 'NoSuchBucket' ||
  httpStatus(error) === 404;

const isNoSuchUpload = (error: unknown): boolean =>
  errorName(error) === 'NoSuchUpload';
