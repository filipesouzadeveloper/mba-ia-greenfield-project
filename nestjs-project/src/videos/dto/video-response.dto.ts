import { ApiProperty } from '@nestjs/swagger';
import { type Video, VideoStatus } from '../entities/video.entity';
import { VIDEO_ALLOWED_CODECS } from '../videos.constants';

type VideoContainer = keyof typeof VIDEO_ALLOWED_CODECS;

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ example: 'clip' })
  title: string;

  @ApiProperty({ example: 'clip.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 150000000 })
  size_bytes: number;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Set only when `status` is `failed`',
  })
  failure_reason: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 12.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({
    enum: Object.keys(VIDEO_ALLOWED_CODECS),
    nullable: true,
    example: 'mp4',
  })
  container: VideoContainer | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 4500000 })
  bitrate: number | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    id: video.id,
    slug: video.slug,
    title: video.title,
    original_filename: video.original_filename,
    mime_type: video.mime_type,
    size_bytes: video.size_bytes,
    status: video.status,
    failure_reason: video.failure_reason,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    // The worker only stores containers from the layer-2 allowlist.
    container: video.container as VideoContainer | null,
    bitrate: video.bitrate,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}
