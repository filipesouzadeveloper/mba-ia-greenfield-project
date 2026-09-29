---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: nestjs-project/test/videos-stream.e2e-spec.ts
---

# GET /videos/{slug}/stream e /download Test Plan

## Application Overview

`GET /videos/{slug}/stream` e `GET /videos/{slug}/download` são rotas públicas (`@Public()`) que transmitem o original do bucket privado sem bufferizar, repassando o header `Range` ao `GetObject`: com `Range` válido respondem `206` com `Content-Range`; sem `Range`, `200` com o arquivo completo; `Range` insatisfazível gera `416 RANGE_NOT_SATISFIABLE` com `Content-Range: bytes */{size}`. `/download` acrescenta `Content-Disposition: attachment` com o nome original. Só vídeos `ready` são servidos; qualquer outro status ou slug inexistente gera `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. GET /videos/{slug}/stream e /download (SI-03.10)

**Setup:** Bootstrap do `AppModule` com a config global de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), como em `test/auth.e2e-spec.ts`. `beforeAll` gera o MP4 H.264+AAC de 2s com `src/test/video-fixtures.ts` e guarda seus bytes e tamanho (S). `beforeEach` roda `cleanAllTables(dataSource)`, cria um usuário confirmado com login e sobe o fixture pela API: `POST /videos` com `{ "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": S }`, PUT dos bytes na URL da parte 1 e `POST /videos/{id}/upload/complete`. Em seguida marca o vídeo como pronto via repositório (`status = ready`, `container = mp4`) — a transição real pelo worker é coberta em `video.processor.integration-spec.ts`. Postgres, MinIO e Redis reais (`QUEUE_PREFIX=streamtube-test`). Todas as requisições às rotas públicas são feitas **sem** header `Authorization`. `afterAll` fecha o app.

#### 1.1. streams-partial-content-for-range

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{slug}/stream sem token, com header `Range: bytes=0-1023`
    - expect: status 206
    - expect: `Content-Range` = `bytes 0-1023/S`, `Accept-Ranges` = `bytes`, `Content-Length` = 1024 e `Content-Type` = `video/mp4`
    - expect: o corpo tem 1024 bytes, iguais aos 1024 primeiros bytes do fixture

#### 1.2. streams-full-file-without-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{slug}/stream sem token e sem `Range` (resposta lida como buffer)
    - expect: status 200 com `Content-Length` = S e `Accept-Ranges` = `bytes`
    - expect: o corpo é byte a byte idêntico ao fixture enviado

#### 1.3. rejects-unsatisfiable-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{slug}/stream sem token, com header `Range: bytes=S-`
    - expect: status 416 com `error` = `"RANGE_NOT_SATISFIABLE"`
    - expect: header `Content-Range` = `bytes */S`

#### 1.4. download-sets-attachment-disposition

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{slug}/download sem token e sem `Range`
    - expect: status 200 com `Content-Length` = S
    - expect: `Content-Disposition` começa com `attachment` e contém `filename="clip.mp4"` e `filename*=UTF-8''clip.mp4`
  2. GET /videos/{slug}/download sem token, com `Range: bytes=0-99`
    - expect: status 206 com `Content-Range` = `bytes 0-99/S` e o mesmo `Content-Disposition`

#### 1.5. returns-not-found-when-not-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. Atualizar o vídeo via repositório para `status = processing`; GET /videos/{slug}/stream sem token
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
  2. Atualizar o vídeo para `status = draft`; GET /videos/{slug}/stream sem token
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
  3. GET /videos/inexistente1/stream e GET /videos/inexistente1/download sem token
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"` em ambas
