export interface ByteRange {
  start: number;
  end: number;
}

export const RANGE_UNSATISFIABLE = 'unsatisfiable';

export type ParsedRange = ByteRange | null | typeof RANGE_UNSATISFIABLE;

const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

const toOffset = (digits: string): number | null => {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
};

/**
 * Parses a `Range` request header against an object of `size` bytes.
 * `null` means "serve the whole object" (no header, or several ranges,
 * which this API does not serve as multipart/byteranges).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ParsedRange {
  if (header === undefined) return null;
  const value = header.trim();
  if (value === '') return null;
  if (value.includes(',')) return null;

  const match = SINGLE_BYTE_RANGE.exec(value);
  if (!match) return RANGE_UNSATISFIABLE;
  const [, startDigits, endDigits] = match;

  if (startDigits === '') {
    // Suffix range: the last N bytes.
    const suffix = endDigits === '' ? null : toOffset(endDigits);
    if (suffix === null || suffix === 0 || size === 0) {
      return RANGE_UNSATISFIABLE;
    }
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = toOffset(startDigits);
  if (start === null || start >= size) return RANGE_UNSATISFIABLE;
  if (endDigits === '') return { start, end: size - 1 };

  const end = toOffset(endDigits);
  if (end === null || start > end) return RANGE_UNSATISFIABLE;
  return { start, end: Math.min(end, size - 1) };
}

export const formatByteRange = ({ start, end }: ByteRange): string =>
  `bytes=${start}-${end}`;

// RFC 5987 attr-char excludes the characters encodeURIComponent keeps.
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * `attachment` disposition with an ASCII fallback for old clients and the
 * exact UTF-8 name in `filename*` (RFC 6266).
 */
export function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}
