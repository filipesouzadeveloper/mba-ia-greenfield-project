export const VIDEO_MAX_SIZE_BYTES = 10_737_418_240; // 10 GiB
export const VIDEO_PART_SIZE_BYTES = 67_108_864; // 64 MiB
export const VIDEO_PART_URL_EXPIRES_SECONDS = 3600;
export const VIDEO_SLUG_LENGTH = 11;
export const VIDEO_SLUG_MAX_RETRIES = 5;
export const VIDEO_STALE_UPLOAD_HOURS = 24;
export const VIDEO_SLUG_UNIQUE_CONSTRAINT = 'UQ_videos_slug';
export const VIDEO_TITLE_MAX_LENGTH = 100;

// Closed set of values stored in `videos.failure_reason`.
export const VIDEO_FAILURE_REASONS = {
  NOT_A_VIDEO: 'NOT_A_VIDEO',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
} as const;

export type VideoFailureReason =
  (typeof VIDEO_FAILURE_REASONS)[keyof typeof VIDEO_FAILURE_REASONS];

// Layer 1 (pre-registration): declared MIME type → accepted file extension.
export const VIDEO_ALLOWED_UPLOAD_FORMATS = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
} as const;

// Canonical container (set by the worker) → `Content-Type` served on playback.
export const VIDEO_CONTAINER_MIME_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
};

// Layer 2 (worker, ffprobe): canonical container → accepted codecs.
// `null` audio codec means a video without an audio stream.
export const VIDEO_ALLOWED_CODECS = {
  mp4: { video: ['h264'], audio: ['aac', 'mp3', null] },
  webm: { video: ['vp8', 'vp9'], audio: ['opus', 'vorbis', null] },
} as const;
