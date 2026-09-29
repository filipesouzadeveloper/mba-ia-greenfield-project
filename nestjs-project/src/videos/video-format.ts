import { extname } from 'path';
import { UnsupportedVideoFormatException } from '../common/exceptions/domain.exception';
import type { FfprobeOutput, FfprobeStream } from '../worker/ffmpeg.service';
import { VideoProcessingFailure } from './video-processing-failure';
import {
  VIDEO_ALLOWED_CODECS,
  VIDEO_ALLOWED_UPLOAD_FORMATS,
  VIDEO_FAILURE_REASONS,
} from './videos.constants';

type AllowedUploadMimeType = keyof typeof VIDEO_ALLOWED_UPLOAD_FORMATS;
type VideoContainer = keyof typeof VIDEO_ALLOWED_CODECS;

export interface ProbeClassification {
  container: VideoContainer;
  video_codec: string;
  audio_codec: string | null;
}

const isAllowedUploadMimeType = (
  contentType: string,
): contentType is AllowedUploadMimeType =>
  Object.hasOwn(VIDEO_ALLOWED_UPLOAD_FORMATS, contentType);

// Layer 1 (pre-registration): the declared MIME type must be in the allowlist
// and the file extension must match it. The worker's ffprobe (layer 2) is the
// authoritative check on the actual content.
export function assertUploadFormat(
  filename: string,
  contentType: string,
): void {
  if (!isAllowedUploadMimeType(contentType)) {
    throw new UnsupportedVideoFormatException();
  }
  const extension = extname(filename).toLowerCase();
  if (extension !== VIDEO_ALLOWED_UPLOAD_FORMATS[contentType]) {
    throw new UnsupportedVideoFormatException();
  }
}

// A cover image (e.g. album art in an audio file) is reported as a video
// stream but is not a video.
export function findVideoStream(
  probe: FfprobeOutput,
): FfprobeStream | undefined {
  return probe.streams.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
}

// Layer 2 (worker, authoritative): ffprobe reports MP4/MOV and WebM/MKV with
// the same demuxer, so the container alone is not enough — the codecs must
// also be in the allowlist.
export function classifyProbe(probe: FfprobeOutput): ProbeClassification {
  const videoStream = findVideoStream(probe);
  if (!videoStream) {
    throw new VideoProcessingFailure(VIDEO_FAILURE_REASONS.NOT_A_VIDEO);
  }
  const audioStream = probe.streams.find(
    (stream) => stream.codec_type === 'audio',
  );

  const container = canonicalContainer(probe.format.format_name);
  const videoCodec = videoStream.codec_name;
  // An audio stream with an unidentified codec must not pass as "no audio".
  const audioCodec = audioStream ? (audioStream.codec_name ?? '') : null;
  if (
    !container ||
    !videoCodec ||
    !isAllowedCodec(VIDEO_ALLOWED_CODECS[container].video, videoCodec) ||
    !isAllowedCodec(VIDEO_ALLOWED_CODECS[container].audio, audioCodec)
  ) {
    throw new VideoProcessingFailure(VIDEO_FAILURE_REASONS.UNSUPPORTED_FORMAT);
  }

  return { container, video_codec: videoCodec, audio_codec: audioCodec };
}

function canonicalContainer(formatName = ''): VideoContainer | null {
  const names = formatName.split(',');
  const containers = Object.keys(VIDEO_ALLOWED_CODECS) as VideoContainer[];
  return containers.find((container) => names.includes(container)) ?? null;
}

const isAllowedCodec = (
  allowed: readonly (string | null)[],
  codec: string | null,
): boolean => allowed.includes(codec);
