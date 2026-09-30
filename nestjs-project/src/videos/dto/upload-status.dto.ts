import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';
import { MultipartUploadDto } from './created-video-draft.dto';

export class ResumableUploadDto extends MultipartUploadDto {
  @ApiProperty({
    type: [Number],
    example: [1],
    description: 'Part numbers already stored, in ascending order',
  })
  uploaded_parts: number[];
}

export class UploadStatusDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: [VideoStatus.DRAFT], example: VideoStatus.DRAFT })
  status: VideoStatus.DRAFT;

  @ApiProperty({
    type: ResumableUploadDto,
    description: '`parts` holds presigned URLs only for the missing parts',
  })
  upload: ResumableUploadDto;
}
