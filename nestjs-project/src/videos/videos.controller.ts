import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'stream/promises';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RangeNotSatisfiableException } from '../common/exceptions/domain.exception';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompletedUploadDto } from './dto/completed-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreatedVideoDraftDto } from './dto/created-video-draft.dto';
import { UploadStatusDto } from './dto/upload-status.dto';
import { toVideoResponse, VideoResponseDto } from './dto/video-response.dto';
import { buildContentDisposition, RANGE_UNSATISFIABLE } from './http-range';
import { VideosService, type VideoStream } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft in the authenticated user's channel, starts a multipart upload in the object storage and returns presigned URLs for every part. The video bytes go straight to the storage, never through the API.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: CreatedVideoDraftDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds 10 GiB',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'Unsupported format: MIME type or extension outside MP4/WebM, or extension inconsistent with the MIME type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreatedVideoDraftDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns the video to its owner, including the processing status, the failure reason and the metadata extracted by the worker (null until processing ends).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({
    status: 200,
    description: 'Video with status and extracted metadata',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Video id is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "Video not found or not in the user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedOrFail(user.sub, id);
    return toVideoResponse(video);
  }

  @Get(':slug/stream')
  @Public()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Streams the original file of a ready video from the private storage without buffering it. A single-range `Range` header returns 206 with that byte range, which lets players seek without downloading the whole file; without it the whole file is returned.',
  })
  @ApiParam({ name: 'slug', description: 'Video slug' })
  @ApiHeader({
    name: 'Range',
    required: false,
    description:
      'Single byte range: `bytes=start-end`, `bytes=start-` or `bytes=-suffix`. Multiple ranges are ignored and the whole file is returned.',
  })
  @ApiProduces('video/mp4', 'video/webm')
  @ApiResponse({
    status: 200,
    description: 'Whole file',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 206,
    description: 'Requested byte range, described by `Content-Range`',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description:
      'Range starts beyond the file, is reversed or is malformed; `Content-Range: bytes */{size}` carries the file size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('slug') slug: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const stream = await this.videosService.openStream(slug, range);
    await this.sendVideo(res, stream);
  }

  @Get(':slug/download')
  @Public()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Same as streaming, plus `Content-Disposition: attachment` with the original filename. `Range` is honored, so an interrupted download can be resumed.',
  })
  @ApiParam({ name: 'slug', description: 'Video slug' })
  @ApiHeader({
    name: 'Range',
    required: false,
    description:
      'Single byte range: `bytes=start-end`, `bytes=start-` or `bytes=-suffix`. Multiple ranges are ignored and the whole file is returned.',
  })
  @ApiProduces('video/mp4', 'video/webm')
  @ApiResponse({
    status: 200,
    description: 'Whole file as an attachment',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 206,
    description:
      'Requested byte range as an attachment, described by `Content-Range`',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description:
      'Range starts beyond the file, is reversed or is malformed; `Content-Range: bytes */{size}` carries the file size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('slug') slug: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const stream = await this.videosService.openStream(slug, range);
    await this.sendVideo(
      res,
      stream,
      buildContentDisposition(stream.video.original_filename),
    );
  }

  @Get(':slug/thumbnail')
  @Public()
  @ApiOperation({
    summary: 'Get a video thumbnail',
    description:
      'Streams the thumbnail generated during processing from the private storage. Only ready videos expose it.',
  })
  @ApiParam({ name: 'slug', description: 'Video slug' })
  @ApiProduces('image/jpeg')
  @ApiResponse({
    status: 200,
    description: 'JPEG thumbnail',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const { body, contentLength, contentType } =
      await this.videosService.openThumbnail(slug);
    // The worker stores the thumbnail with its Content-Type (image/jpeg).
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    res.setHeader('Content-Length', contentLength);
    await pipeline(body, res);
  }

  @Get(':id/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Resume a video upload',
    description:
      'Lists the parts of the multipart upload already stored and returns fresh presigned URLs only for the missing ones. Only the owner of a draft video can call it.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({
    status: 200,
    description: 'Upload status with URLs for the missing parts',
    type: UploadStatusDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Video id is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "Video not found or not in the user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadStatusDto> {
    return this.videosService.getUploadStatus(user.sub, id);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload with the parts already stored, checks the final object and queues the video for processing, moving it from draft to processing. Only the owner of a draft video can call it.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and video queued for processing',
    type: CompletedUploadDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Video id is not a UUID',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "Video not found or not in the user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'Video is no longer a draft (INVALID_VIDEO_STATUS) or some parts are missing (UPLOAD_INCOMPLETE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description:
      'Stored object exceeds 10 GiB; it is removed and the video fails',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CompletedUploadDto> {
    return this.videosService.completeUpload(user.sub, id);
  }

  private async sendVideo(
    res: Response,
    stream: VideoStream,
    contentDisposition?: string,
  ): Promise<void> {
    const { video } = stream;
    if (stream.range === RANGE_UNSATISFIABLE) {
      res.setHeader('Content-Range', `bytes */${video.size_bytes}`);
      throw new RangeNotSatisfiableException();
    }

    const { range, body, contentType } = stream;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (contentDisposition) {
      res.setHeader('Content-Disposition', contentDisposition);
    }
    if (range) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${video.size_bytes}`,
      );
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.status(HttpStatus.OK);
      res.setHeader('Content-Length', video.size_bytes);
    }
    await pipeline(body, res);
  }
}
