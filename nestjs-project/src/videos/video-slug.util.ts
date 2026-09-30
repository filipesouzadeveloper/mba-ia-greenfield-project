import { randomBytes } from 'node:crypto';
import { VIDEO_SLUG_LENGTH } from './videos.constants';

// 9 random bytes → 12 base64url chars; the first 11 carry ~66 bits of entropy.
export function generateVideoSlug(): string {
  return randomBytes(9).toString('base64url').slice(0, VIDEO_SLUG_LENGTH);
}
