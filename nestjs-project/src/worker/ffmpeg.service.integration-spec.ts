import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  generateVideoFixture,
  type VideoFixture,
} from '../test/video-fixtures';
import { FfmpegService, UnrecognizedMediaError } from './ffmpeg.service';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegService (integration)', () => {
  const ffmpeg = new FfmpegService();
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ffmpeg-service-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeFixture(fixture: VideoFixture): Promise<string> {
    const path = join(dir, fixture);
    await writeFile(path, await generateVideoFixture(fixture));
    return path;
  }

  describe('probe', () => {
    it('should report the duration, dimensions and codecs of an H.264/AAC MP4', async () => {
      const path = await writeFixture('mp4-h264-aac');

      const probe = await ffmpeg.probe(path);

      expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
      expect(probe.format.format_name?.split(',')).toContain('mp4');
      expect(Number(probe.format.bit_rate)).toBeGreaterThan(0);
      const video = probe.streams.find((s) => s.codec_type === 'video');
      expect(video).toMatchObject({
        codec_name: 'h264',
        width: 320,
        height: 240,
      });
      const audio = probe.streams.find((s) => s.codec_type === 'audio');
      expect(audio?.codec_name).toBe('aac');
    });

    it('should reject input that no demuxer recognizes as media', async () => {
      const path = await writeFixture('text');

      await expect(ffmpeg.probe(path)).rejects.toBeInstanceOf(
        UnrecognizedMediaError,
      );
    });

    it('should propagate other ffprobe failures as they are', async () => {
      const probe = ffmpeg.probe(join(dir, 'missing-file'));

      await expect(probe).rejects.not.toBeInstanceOf(UnrecognizedMediaError);
      await expect(probe).rejects.toThrow(/No such file/);
    });
  });

  describe('extractThumbnail', () => {
    it('should return a JPEG frame', async () => {
      const path = await writeFixture('mp4-h264-aac');

      const thumbnail = await ffmpeg.extractThumbnail(path, 0.2);

      expect(thumbnail.subarray(0, 3)).toEqual(JPEG_MAGIC);
      const probe = await ffmpeg.probe(await writeJpeg(thumbnail));
      expect(probe.streams[0]).toMatchObject({
        codec_name: 'mjpeg',
        width: 320,
        height: 240,
      });
    });
  });

  async function writeJpeg(bytes: Buffer): Promise<string> {
    const path = join(dir, 'thumbnail.jpg');
    await writeFile(path, bytes);
    return path;
  }
});
