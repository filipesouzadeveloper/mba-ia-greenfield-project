import { UnsupportedVideoFormatException } from '../common/exceptions/domain.exception';
import { assertUploadFormat } from './video-format';

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
