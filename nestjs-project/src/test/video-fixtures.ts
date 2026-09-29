import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// 2s of synthetic 320x240 picture and a sine tone.
const TEST_SOURCES = [
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=2:size=320x240:rate=25',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=2',
];

const FIXTURES = {
  'mp4-h264-aac': {
    extension: 'mp4',
    codecs: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  },
  'webm-vp9-opus': {
    extension: 'webm',
    codecs: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-c:a', 'libopus'],
  },
  'mp4-mpeg4': {
    extension: 'mp4',
    codecs: ['-c:v', 'mpeg4', '-c:a', 'aac'],
  },
} as const;

export type VideoFixture = keyof typeof FIXTURES | 'text';

export async function generateVideoFixture(
  fixture: VideoFixture,
): Promise<Buffer> {
  if (fixture === 'text') {
    return Buffer.from('This is a plain text file, not a video.\n');
  }

  const { extension, codecs } = FIXTURES[fixture];
  const dir = await mkdtemp(join(tmpdir(), 'video-fixture-'));
  const output = join(dir, `${fixture}.${extension}`);
  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      ...TEST_SOURCES,
      ...codecs,
      '-shortest',
      output,
    ]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
