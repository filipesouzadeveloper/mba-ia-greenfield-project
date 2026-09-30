import { UnrecoverableError } from 'bullmq';
import { UnsupportedVideoFormatException } from '../common/exceptions/domain.exception';
import type { FfprobeOutput, FfprobeStream } from '../worker/ffmpeg.service';
import { assertUploadFormat, classifyProbe } from './video-format';
import { VideoProcessingFailure } from './video-processing-failure';
import { VIDEO_FAILURE_REASONS } from './videos.constants';

const MP4_FORMAT_NAME = 'mov,mp4,m4a,3gp,3g2,mj2';
const WEBM_FORMAT_NAME = 'matroska,webm';

function buildProbe(
  formatName: string,
  videoCodec: string | null,
  audioCodec: string | null,
): FfprobeOutput {
  const streams: FfprobeStream[] = [];
  if (videoCodec) {
    streams.push({
      index: streams.length,
      codec_type: 'video',
      codec_name: videoCodec,
    });
  }
  if (audioCodec) {
    streams.push({
      index: streams.length,
      codec_type: 'audio',
      codec_name: audioCodec,
    });
  }
  return { streams, format: { format_name: formatName } };
}

function failureReasonOf(probe: FfprobeOutput): string {
  try {
    classifyProbe(probe);
  } catch (error) {
    if (error instanceof VideoProcessingFailure) return error.failureReason;
    throw error;
  }
  throw new Error('classifyProbe accepted the probe');
}

describe('classifyProbe', () => {
  it.each([
    [MP4_FORMAT_NAME, 'h264', 'aac', 'mp4'],
    [MP4_FORMAT_NAME, 'h264', 'mp3', 'mp4'],
    [MP4_FORMAT_NAME, 'h264', null, 'mp4'],
    [WEBM_FORMAT_NAME, 'vp9', 'opus', 'webm'],
    [WEBM_FORMAT_NAME, 'vp8', 'vorbis', 'webm'],
    [WEBM_FORMAT_NAME, 'vp9', null, 'webm'],
  ])(
    'should accept %s with video %s and audio %s as %s',
    (formatName, videoCodec, audioCodec, container) => {
      const result = classifyProbe(
        buildProbe(formatName, videoCodec, audioCodec),
      );

      expect(result).toEqual({
        container,
        video_codec: videoCodec,
        audio_codec: audioCodec,
      });
    },
  );

  it.each([
    ['MP4 with mpeg4 video', MP4_FORMAT_NAME, 'mpeg4', 'aac'],
    ['MP4 with hevc video', MP4_FORMAT_NAME, 'hevc', 'aac'],
    ['MP4 with opus audio', MP4_FORMAT_NAME, 'h264', 'opus'],
    ['WebM with h264 video (typical MKV)', WEBM_FORMAT_NAME, 'h264', 'aac'],
    ['WebM with aac audio', WEBM_FORMAT_NAME, 'vp9', 'aac'],
    ['MOV with prores video', MP4_FORMAT_NAME, 'prores', 'pcm_s16le'],
    ['AVI container', 'avi', 'h264', 'mp3'],
  ])(
    'should reject %s as UNSUPPORTED_FORMAT',
    (_, formatName, video, audio) => {
      expect(failureReasonOf(buildProbe(formatName, video, audio))).toBe(
        VIDEO_FAILURE_REASONS.UNSUPPORTED_FORMAT,
      );
    },
  );

  it('should reject an audio stream whose codec ffprobe could not name', () => {
    const probe = buildProbe(MP4_FORMAT_NAME, 'h264', null);
    probe.streams.push({ index: 1, codec_type: 'audio' });

    expect(failureReasonOf(probe)).toBe(
      VIDEO_FAILURE_REASONS.UNSUPPORTED_FORMAT,
    );
  });

  it('should reject a file without a video stream as NOT_A_VIDEO', () => {
    expect(failureReasonOf(buildProbe('mp3', null, 'mp3'))).toBe(
      VIDEO_FAILURE_REASONS.NOT_A_VIDEO,
    );
  });

  it('should not count cover art as a video stream', () => {
    const probe = buildProbe(MP4_FORMAT_NAME, null, 'aac');
    probe.streams.push({
      index: 1,
      codec_type: 'video',
      codec_name: 'mjpeg',
      disposition: { attached_pic: 1 },
    });

    expect(failureReasonOf(probe)).toBe(VIDEO_FAILURE_REASONS.NOT_A_VIDEO);
  });

  it('should make the failure unrecoverable so the job is not retried', () => {
    expect(() =>
      classifyProbe(buildProbe(MP4_FORMAT_NAME, 'mpeg4', 'aac')),
    ).toThrow(UnrecoverableError);
  });
});

describe('assertUploadFormat', () => {
  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.webm', 'video/webm'],
    ['my.holiday.clip.mp4', 'video/mp4'],
  ])('should accept %s declared as %s', (filename, contentType) => {
    expect(() => assertUploadFormat(filename, contentType)).not.toThrow();
  });

  it.each([
    ['clip.MP4', 'video/mp4'],
    ['clip.WebM', 'video/webm'],
  ])(
    'should accept the extension case-insensitively (%s)',
    (filename, contentType) => {
      expect(() => assertUploadFormat(filename, contentType)).not.toThrow();
    },
  );

  it.each([
    ['clip.mp4', 'video/quicktime'],
    ['clip.mkv', 'video/x-matroska'],
    ['clip.mp4', 'VIDEO/MP4'],
    ['clip.mp4', 'toString'],
  ])(
    'should reject %s declared with MIME type %s outside the allowlist',
    (filename, contentType) => {
      expect(() => assertUploadFormat(filename, contentType)).toThrow(
        UnsupportedVideoFormatException,
      );
    },
  );

  it.each([
    ['clip.mov', 'video/mp4'],
    ['clip', 'video/mp4'],
    ['.mp4', 'video/mp4'],
  ])(
    'should reject %s whose extension is not allowed for video/mp4',
    (filename, contentType) => {
      expect(() => assertUploadFormat(filename, contentType)).toThrow(
        UnsupportedVideoFormatException,
      );
    },
  );

  it.each([
    ['clip.webm', 'video/mp4'],
    ['clip.mp4', 'video/webm'],
  ])(
    'should reject %s when the extension does not match %s',
    (filename, contentType) => {
      expect(() => assertUploadFormat(filename, contentType)).toThrow(
        UnsupportedVideoFormatException,
      );
    },
  );
});
