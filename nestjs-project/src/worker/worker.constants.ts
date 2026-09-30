export const THUMBNAIL = {
  POSITION_RATIO: 0.1,
  // Shorter videos use the first frame.
  MIN_DURATION_SECONDS: 1,
  MAX_WIDTH: 1280,
  CONTENT_TYPE: 'image/jpeg',
  MAX_BYTES: 16 * 1024 * 1024,
} as const;

export const CLEANUP_STALE_UPLOADS_SCHEDULE = {
  SCHEDULER_ID: 'cleanup-stale-uploads',
  EVERY_MS: 3_600_000, // 1 hour
  KEEP_FAILED_JOBS: 100,
} as const;
