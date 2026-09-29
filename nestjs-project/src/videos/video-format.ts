import { extname } from 'path';
import { UnsupportedVideoFormatException } from '../common/exceptions/domain.exception';
import { VIDEO_ALLOWED_UPLOAD_FORMATS } from './videos.constants';

type AllowedUploadMimeType = keyof typeof VIDEO_ALLOWED_UPLOAD_FORMATS;

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
