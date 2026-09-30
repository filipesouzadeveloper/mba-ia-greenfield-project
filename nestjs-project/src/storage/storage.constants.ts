export const S3_INTERNAL_CLIENT = 'S3_INTERNAL_CLIENT';
export const S3_PUBLIC_CLIENT = 'S3_PUBLIC_CLIENT';

export const STORAGE_PRESIGN_TTL_SECONDS = {
  UPLOAD_PART: 3600,
  GET_OBJECT: 900,
} as const;

export const STORAGE_KEYS = {
  PREFIX: 'videos',
  ORIGINAL: 'original',
  THUMBNAIL: 'thumbnail.jpg',
} as const;
