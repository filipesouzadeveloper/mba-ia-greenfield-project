import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CompletedUploadDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({
    enum: [VideoStatus.PROCESSING],
    example: VideoStatus.PROCESSING,
  })
  status: VideoStatus.PROCESSING;
}
