import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VIDEO_SLUG_UNIQUE_CONSTRAINT } from '../videos.constants';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

// `pg` returns bigint as string; 10 GiB is well below Number.MAX_SAFE_INTEGER.
const bigintToNumber: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Index('IDX_videos_status_created_at', ['status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index(VIDEO_SLUG_UNIQUE_CONSTRAINT, { unique: true })
  @Column({ type: 'varchar', length: 11 })
  slug: string;

  @Index('IDX_videos_channel_id')
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 50 })
  mime_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size_bytes: number;

  @Column({ type: 'text', nullable: true })
  upload_id: string | null;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 50, nullable: true })
  failure_reason: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  container: string | null;

  @Column({ type: 'integer', nullable: true })
  bitrate: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
