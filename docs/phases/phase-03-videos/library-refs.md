---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-09-28T14:20:35-03:00"
  "bullmq":
    version: "^6.3.9"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-28T14:20:35-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1141.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T14:20:35-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1141.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T14:20:35-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T14:14:29-03:00"
---

# Library References — phase-03-videos

Versões: últimas publicadas no npm em 2026-09-28 (nenhuma dessas libs está instalada em `nestjs-project/` ainda). `@nestjs/bullmq@12` declara peer `@nestjs/common`/`@nestjs/core` `^10 || ^11 || ^12` e `bullmq` `^3 … ^6` — compatível com o NestJS 11 do projeto.

### @nestjs/bullmq

Usado por `phase-03-videos/TD-01` (fila) e `TD-07` (worker em container separado, mesmo código).

- Conexão: `BullModule.forRootAsync({ inject: [...], useFactory: () => ({ connection: { host, port } }) })` — host = nome do serviço Compose (`redis`), nunca `localhost`.
- Registro da fila: `BullModule.registerQueue({ name: 'video-processing' })` no módulo que produz e no que consome.
- Produtor: injetar com `@InjectQueue('<nome>') private queue: Queue` (tipo `Queue` importado de `bullmq`).
- Consumidor: classe `@Processor('<nome>')` que `extends WorkerHost` e implementa `async process(job: Job): Promise<unknown>`; o retorno fica no job. Deve ser registrada como provider.
- Eventos do worker: `@OnWorkerEvent('active' | 'completed' | 'failed')` dentro da classe `@Processor`.

```ts
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* grava failure_reason (TD-11) */ }
}
```

### bullmq

Usado por `phase-03-videos/TD-01`, `TD-11`, `TD-13`.

- Retry: `queue.add(name, data, { attempts: N, backoff: { type: 'exponential', delay: ms } })`.
- Idempotência por vídeo: `jobId` customizado (ex.: `video-<id>`) — um job com o mesmo `jobId` existente não é duplicado. Alternativa: opção `deduplication: { id }` (modo simples: deduplica até o job terminar).
- Falha definitiva: `throw new UnrecoverableError(msg)` no worker move o job para `failed` ignorando `attempts` — usar para formato fora da allowlist (TD-13) ou arquivo que não é vídeo.
- Limpeza: `removeOnComplete` / `removeOnFail` nas job options.

```ts
import { UnrecoverableError } from 'bullmq';
await queue.add('process', { videoId }, {
  jobId: `video-${videoId}`,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
});
```

### @aws-sdk/client-s3

Usado por `phase-03-videos/TD-02`, `TD-04`, `TD-05`, `TD-08`, `TD-10`.

- Cliente para MinIO: `new S3Client({ endpoint, forcePathStyle: true, region, credentials: { accessKeyId, secretAccessKey } })`. Dois clientes/configs conforme TD-04: `S3_ENDPOINT` (interno, `http://minio:9000`) para chamadas da API/worker e `S3_PUBLIC_ENDPOINT` para assinar URLs entregues ao navegador.
- Multipart (TD-05): `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; partes `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` (1–10.000), cada resposta devolve `ETag`; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })`; `AbortMultipartUploadCommand` para limpeza.
- Validação na conclusão: `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType`, `ETag`.
- Streaming/download (TD-10): `GetObjectCommand({ Bucket, Key, Range: 'bytes=start-end' })`; `Body` é stream (`StreamingBlobPayloadOutputTypes`), repassar ao response com `206`, `Content-Range`, `Accept-Ranges: bytes`. `ResponseContentDisposition` controla o nome do arquivo no download.

### @aws-sdk/s3-request-presigner

Usado por `phase-03-videos/TD-05` (URLs de parte) e `TD-08` (URL interna para o FFmpeg ler o original).

- `getSignedUrl(client, command, { expiresIn })` — `expiresIn` em segundos, padrão 900 (15 min). TD-05 propõe 1h (`3600`) para as partes.
- Funciona com qualquer comando: `UploadPartCommand` (upload direto do browser, cliente com endpoint público) e `GetObjectCommand` (worker/FFmpeg, cliente com endpoint interno).

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const url = await getSignedUrl(
  publicS3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);
```
