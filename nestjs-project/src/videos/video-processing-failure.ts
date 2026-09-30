import { UnrecoverableError } from 'bullmq';
import type { VideoFailureReason } from './videos.constants';

// A failure caused by the file itself: retrying the job cannot change the
// outcome, so BullMQ moves it straight to failed.
export class VideoProcessingFailure extends UnrecoverableError {
  constructor(readonly failureReason: VideoFailureReason) {
    super(failureReason);
  }
}
