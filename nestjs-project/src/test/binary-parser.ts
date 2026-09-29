import type { Response } from 'supertest';

// supertest parser that collects the raw response bytes whatever the
// Content-Type: `.buffer(true).parse(binaryParser)`.
export const binaryParser = (
  res: Response,
  callback: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
