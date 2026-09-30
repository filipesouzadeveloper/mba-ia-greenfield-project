---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/{id}/upload/complete Test Plan

## Application Overview

`POST /videos/{id}/upload/complete` conclui o multipart no MinIO com as partes/ETags lidas do próprio storage, confere o objeto (`HeadObject`) e dispara o processamento: o vídeo vai de `draft` a `processing` e um job `process-video` com `jobId` = id do vídeo entra na fila BullMQ `video-processing`. Partes faltando geram `409 UPLOAD_INCOMPLETE`; vídeo fora de `draft` gera `409 INVALID_VIDEO_STATUS` sem reenfileirar; vídeo de outro canal gera `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. POST /videos/{id}/upload/complete (SI-03.7)

**Setup:** Bootstrap do `AppModule` com a config global de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), como em `test/auth.e2e-spec.ts`. Obter a fila via `app.get(getQueueToken('video-processing'))`. `beforeEach` roda `cleanAllTables(dataSource)`, `queue.obliterate({ force: true })` e cria dois usuários confirmados com login (dono e outro). Postgres, MinIO e Redis reais (`QUEUE_PREFIX=streamtube-test`); o `AppModule` não registra o `VideoProcessor`, então o job fica aguardando na fila. `afterAll` fecha o app.

#### 1.1. completes-upload-and-enqueues-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos com Bearer do dono e `{ "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": <N> }` com N pequeno (1 parte), depois PUT de N bytes na URL da parte 1
    - expect: status 201 no pré-cadastro e 200 no PUT
  2. POST /videos/{id}/upload/complete com Bearer do dono
    - expect: status 202 com `id` do vídeo, `slug` e `status` = `"processing"`
  3. Verificar storage, banco e fila
    - expect: o objeto `videos/{id}/original` existe no bucket com `ContentLength` = N
    - expect: o registro em `videos` tem `status = processing`, `upload_id = null` e `size_bytes = N`
    - expect: `queue.getJob(id)` devolve um job de nome `process-video` com `data.videoId` = id

#### 1.2. rejects-incomplete-upload

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos com Bearer do dono e `size_bytes` = 100000000 (2 partes), depois PUT só na URL da parte 1
    - expect: status 201 no pré-cadastro e 200 no PUT
  2. POST /videos/{id}/upload/complete com Bearer do dono
    - expect: status 409 com `error` = `"UPLOAD_INCOMPLETE"`
  3. Consultar o registro e a fila
    - expect: o vídeo continua com `status = draft` e `upload_id` preenchido
    - expect: nenhum job com `jobId` = id na fila

#### 1.3. does-not-requeue-video-already-processing

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. Concluir um upload de 1 parte como em 1.1
    - expect: status 202
  2. Repetir POST /videos/{id}/upload/complete com Bearer do dono
    - expect: status 409 com `error` = `"INVALID_VIDEO_STATUS"`
  3. Contar os jobs da fila (`queue.getJobCounts()`)
    - expect: existe um único job `process-video` para o vídeo

#### 1.4. hides-video-from-other-channel

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. Pré-cadastrar e enviar a única parte pelo dono; POST /videos/{id}/upload/complete com Bearer do outro usuário
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
    - expect: o vídeo continua `draft` e a fila segue vazia

#### 1.5. requires-authentication

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. POST /videos/{id}/upload/complete sem header `Authorization`
    - expect: status 401 (Authorization Matrix: anônimo ✗)
