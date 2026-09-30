// Loaded by Jest after `dotenv/config` (unit, integration and e2e).
// Isolates test jobs from dev jobs in the shared Redis, and signs presigned
// URLs with the internal MinIO host: inside the container `localhost:9000`
// does not reach the storage.
process.env.QUEUE_PREFIX = 'streamtube-test';
if (process.env.S3_ENDPOINT) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
}
