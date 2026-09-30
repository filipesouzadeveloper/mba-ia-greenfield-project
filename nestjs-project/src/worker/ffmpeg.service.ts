import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { THUMBNAIL } from './worker.constants';

const execFileAsync = promisify(execFile);

// ffprobe's message when no demuxer recognizes the input.
const FFPROBE_INVALID_DATA = 'Invalid data found when processing input';

export interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
}

export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

export class UnrecognizedMediaError extends Error {
  constructor() {
    super('ffprobe did not recognize the input as media');
    this.name = UnrecognizedMediaError.name;
  }
}

@Injectable()
export class FfmpegService {
  // Reads only the byte ranges it needs when `url` is an HTTP URL.
  async probe(url: string): Promise<FfprobeOutput> {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ]);
      const parsed = JSON.parse(stdout) as Partial<FfprobeOutput>;
      return { streams: parsed.streams ?? [], format: parsed.format ?? {} };
    } catch (error) {
      if (stderrOf(error).includes(FFPROBE_INVALID_DATA)) {
        throw new UnrecognizedMediaError();
      }
      throw error;
    }
  }

  async extractThumbnail(url: string, seconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(seconds),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL.MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: THUMBNAIL.MAX_BYTES },
    );
    if (stdout.length === 0) {
      throw new Error(`ffmpeg produced no frame at ${seconds}s`);
    }
    return stdout;
  }
}

const stderrOf = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return typeof stderr === 'string' ? stderr : '';
};
