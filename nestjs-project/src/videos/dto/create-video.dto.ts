import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class CreateVideoDto {
  /** Original file name; the extension must be `.mp4` or `.webm`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** Declared MIME type: `video/mp4` or `video/webm`. */
  @IsString()
  @IsNotEmpty()
  content_type: string;

  /** File size in bytes (maximum 10 GiB). */
  @IsInt()
  @Min(1)
  size_bytes: number;
}
