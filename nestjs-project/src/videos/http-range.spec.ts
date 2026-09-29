import {
  buildContentDisposition,
  parseRange,
  RANGE_UNSATISFIABLE,
} from './http-range';

const SIZE = 1000;

describe('parseRange', () => {
  it('should return null when there is no Range header', () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
    expect(parseRange('', SIZE)).toBeNull();
  });

  it('should parse a closed range', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('should parse an open-ended range up to the last byte', () => {
    expect(parseRange('bytes=100-', SIZE)).toEqual({ start: 100, end: 999 });
  });

  it('should parse a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-50', SIZE)).toEqual({ start: 950, end: 999 });
  });

  it('should serve the whole object when the suffix exceeds its size', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('should clamp an end beyond the object size to the last byte', () => {
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('should accept a single-byte range on the last byte', () => {
    expect(parseRange('bytes=999-999', SIZE)).toEqual({
      start: 999,
      end: 999,
    });
  });

  it('should be unsatisfiable when the start is at or beyond the size', () => {
    expect(parseRange(`bytes=${SIZE}-`, SIZE)).toBe(RANGE_UNSATISFIABLE);
    expect(parseRange('bytes=5000-6000', SIZE)).toBe(RANGE_UNSATISFIABLE);
  });

  it('should be unsatisfiable when the start is after the end', () => {
    expect(parseRange('bytes=500-100', SIZE)).toBe(RANGE_UNSATISFIABLE);
  });

  it('should be unsatisfiable for a zero-length suffix', () => {
    expect(parseRange('bytes=-0', SIZE)).toBe(RANGE_UNSATISFIABLE);
  });

  it('should be unsatisfiable for any range of an empty object', () => {
    expect(parseRange('bytes=0-', 0)).toBe(RANGE_UNSATISFIABLE);
    expect(parseRange('bytes=-10', 0)).toBe(RANGE_UNSATISFIABLE);
  });

  it.each([
    'bytes=-',
    'bytes=abc-10',
    'bytes=0-1x',
    'items=0-99',
    '0-99',
    'bytes=99999999999999999999-',
  ])('should be unsatisfiable for invalid syntax %p', (header) => {
    expect(parseRange(header, SIZE)).toBe(RANGE_UNSATISFIABLE);
  });

  it('should ignore multiple ranges and serve the whole object', () => {
    expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull();
  });
});

describe('buildContentDisposition', () => {
  it('should keep an ASCII filename in both parameters', () => {
    expect(buildContentDisposition('clip.mp4')).toBe(
      `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
  });

  it('should replace non-ASCII characters in the fallback and percent-encode them in filename*', () => {
    expect(buildContentDisposition('férias.mp4')).toBe(
      `attachment; filename="f_rias.mp4"; filename*=UTF-8''f%C3%A9rias.mp4`,
    );
  });

  it('should neutralize quotes and backslashes that would break the quoted fallback', () => {
    expect(buildContentDisposition('meu "vídeo"\\x.mp4')).toBe(
      `attachment; filename="meu _v_deo__x.mp4"; filename*=UTF-8''meu%20%22v%C3%ADdeo%22%5Cx.mp4`,
    );
  });

  it('should percent-encode characters that RFC 5987 does not allow unescaped', () => {
    expect(buildContentDisposition("it's (1)*.mp4")).toBe(
      `attachment; filename="it's (1)*.mp4"; filename*=UTF-8''it%27s%20%281%29%2A.mp4`,
    );
  });
});
