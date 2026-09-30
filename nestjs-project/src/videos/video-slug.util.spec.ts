import { generateVideoSlug } from './video-slug.util';

describe('generateVideoSlug', () => {
  it('should return 11 characters from the base64url alphabet', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateVideoSlug()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should return distinct values on successive calls', () => {
    const slugs = new Set(
      Array.from({ length: 1000 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(1000);
  });
});
