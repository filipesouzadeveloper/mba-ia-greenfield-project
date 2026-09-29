---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: nestjs-project/test/videos-thumbnail.e2e-spec.ts
---

# GET /videos/{slug}/thumbnail Test Plan

## Application Overview

`GET /videos/{slug}/thumbnail` é rota pública (`@Public()`) que serve pela API, em stream, a thumbnail `videos/{videoId}/thumbnail.jpg` gerada no processamento, mantendo o bucket privado. Só vídeos `ready` têm a thumbnail exposta; qualquer outro status ou slug inexistente gera `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. GET /videos/{slug}/thumbnail (SI-03.11)

**Setup:** Bootstrap do `AppModule` com a config global de `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), como em `test/auth.e2e-spec.ts`. `beforeEach` roda `cleanAllTables(dataSource)`, cria um usuário confirmado com login e pré-cadastra um vídeo pela API (`POST /videos` com `{ "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": 1000 }`). Para o estado pronto: gravar um JPEG gerado pelo FFmpeg (a partir do fixture de `src/test/video-fixtures.ts`) em `videos/{id}/thumbnail.jpg` com o `StorageService` e atualizar o registro via repositório para `status = ready`, `container = mp4` — a geração real pelo worker é coberta em `video.processor.integration-spec.ts`. Postgres e MinIO reais. Requisições feitas **sem** header `Authorization`. `afterAll` fecha o app.

#### 1.1. serves-jpeg-for-ready-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{slug}/thumbnail sem token, de um vídeo `ready` com thumbnail no bucket (resposta lida como buffer)
    - expect: status 200 com `Content-Type` = `image/jpeg` e `Content-Length` igual ao tamanho do JPEG gravado
    - expect: o corpo começa com os bytes de SOI do JPEG (`FF D8 FF`) e é idêntico ao JPEG gravado

#### 1.2. returns-not-found-when-not-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T19:25:00Z

**Steps:**
  1. GET /videos/{slug}/thumbnail sem token, com o vídeo ainda em `draft`
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
  2. Atualizar o vídeo via repositório para `status = failed`; repetir a requisição
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
  3. GET /videos/inexistente1/thumbnail sem token
    - expect: status 404 com `error` = `"VIDEO_NOT_FOUND"`
