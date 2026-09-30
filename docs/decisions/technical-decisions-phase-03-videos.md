---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-28
scope_description: "Fase 03 — upload de vídeos de até 10GB direto ao object storage, fila de processamento, worker FFmpeg (duração, metadados, thumbnail), URL única, streaming com Range/206, download e ciclo de status do vídeo."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o módulo de vídeos (pré-cadastro, upload, consulta, streaming, download), a entidade/migration de vídeos, a integração com object storage e fila, o worker de vídeo e os novos serviços do `compose.yaml` (storage, fila, worker).
- `next-frontend/` — sem decisão aberta nesta fase: a interface de vídeo (player, tela de upload) está fora do escopo da Fase 03 (o player é a Fase 05). Os TDs `Cross-layer` abaixo (TD-05, TD-09, TD-10, TD-13) fixam o contrato HTTP que o frontend consumirá depois, sem exigir código no frontend agora.

**Decisões herdadas (não reabertas):** `phase-02-auth/TD-02` (guard JWT próprio global + `@Public()`), `phase-02-auth/TD-06` (class-validator), `phase-02-auth/TD-07` (erro `{ statusCode, error, message }` com códigos de domínio), `phase-02-auth/TD-08` (`@nestjs/throttler`), `phase-01-configuracao-base/TD-01..TD-04` (`@nestjs/config` + Joi + `registerAs` por domínio), `openapi-docs-nestjs/TD-01..TD-03` (Swagger via CLI plugin + `openapi.json` exportado). O object storage S3-compatível é premissa do projeto (`docs/diagrams/software-arch.mermaid`: "S3 or MinIO"); o que se decide aqui é como usá-lo e qual imagem roda no Compose.

---

## TD-01: Tecnologia da fila de processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama de arquitetura deixa a fila como "TBD". A API publica um job por vídeo enviado e o worker o consome. Requisitos: retry com backoff (o processamento pode falhar de forma transitória), idempotência (não processar o mesmo vídeo duas vezes em paralelo), integração com NestJS 11 e um serviço de fila real subindo no Compose.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Fila sobre Redis; a API usa `Queue.add()` e o worker é uma classe `@Processor()` que estende `WorkerHost`. Novo serviço `redis` no Compose.
- **Pros:** módulo oficial do NestJS (`@nestjs/bullmq` 12.x, peer `@nestjs/common` ^11); `attempts` + `backoff` exponencial nativos; `jobId` customizado deduplica jobs (idempotência por vídeo); `UnrecoverableError` encerra retries para falhas definitivas (ex.: arquivo não é vídeo); eventos `failed`/`completed` no worker.
- **Cons:** adiciona Redis como infraestrutura nova; o estado da fila vive fora do Postgres (sem transação conjunta entre "salvar vídeo" e "enfileirar"); precisa de persistência AOF para não perder jobs num restart.

### Option B: pg-boss (fila no PostgreSQL já existente)
- Fila implementada em tabelas do próprio Postgres (`SKIP LOCKED`); `send()` na API e `work()` no worker.
- **Pros:** zero infraestrutura nova; o job pode ser criado na mesma transação que atualiza o vídeo; retries e expiração nativos.
- **Cons:** sem módulo NestJS oficial (integração manual via provider); exige Node ≥ 22.12 (compatível com o container atual, mas é mais um acoplamento); **não adiciona um serviço de fila ao Compose**, e o enunciado exige "fila, worker e storage reais subindo no Compose", o que torna a escolha arriscada para a avaliação; carga de polling no mesmo banco das requisições.

### Option C: RabbitMQ (AMQP)
- Broker dedicado; a API publica numa exchange e o worker consome de uma queue com ack manual. Novo serviço `rabbitmq` no Compose.
- **Pros:** broker robusto e padrão de mercado; ack/nack e dead-letter exchange nativos; independente de linguagem.
- **Cons:** retry com backoff exige montar DLX + TTL manualmente; integração NestJS via microservices/`@golevelup` é mais verbosa; mais infraestrutura e conceitos (exchanges, bindings) do que o caso de uso (uma fila, um tipo de job) pede.

**Recommendation:** **Option A (BullMQ + Redis)** — é o único caminho com módulo oficial do NestJS 11 que entrega retry com backoff, deduplicação por `jobId` e parada antecipada (`UnrecoverableError`) sem código extra, e adiciona uma fila real e isolada ao Compose. pg-boss seria mais simples em infra, mas não sobe um serviço de fila próprio e deixa o polling no banco transacional; RabbitMQ custa mais configuração para o mesmo resultado.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq

**Revisions:**
- 2026-09-28 — Campo Libraries preenchido com os pacotes citados na prosa (IC-1). Rationale: Explicitar libs da prosa.

---

## TD-02: Imagem do object storage S3-compatível no Compose

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O projeto prevê MinIO localmente. Na pesquisa (2026-09-28), o repositório `minio/minio` no GitHub está arquivado e `docker pull minio/minio` / `quay.io/minio/minio` retornam "pull access denied" / "no such manifest": **a imagem oficial não está mais disponível publicamente**. É preciso escolher uma imagem S3-compatível que suba no Compose e aceite o mesmo SDK (AWS SDK v3) usado contra o S3 em produção. Todas as opções abaixo foram verificadas como baixáveis.

**Options:**

### Option A: `pgsty/minio` (fork comunitário do MinIO, tags `RELEASE.*`)
- Fork de `minio/minio` mantido pelo PGSTY (GitHub `pgsty/minio`: "A MinIO fork maintained by PGSTY", ativo em 2026-09-28), com tags de release fixáveis no Docker Hub (ex.: `RELEASE.2026-08-04T00-00-00Z`).
- **Pros:** continua sendo o servidor MinIO (mesma API S3, mesmo console, mesmas variáveis `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`), o que mantém a premissa do enunciado; versão fixável, o que dá reprodutibilidade.
- **Cons:** mantido por terceiros, não pela MinIO Inc.; continuidade do fork não é garantida.

### Option B: `cgr.dev/chainguard/minio`
- Imagem do MinIO construída pela Chainguard.
- **Pros:** servidor MinIO; imagem mínima e mantida por empresa de segurança de supply chain.
- **Cons:** o catálogo de tags do registry `cgr.dev` exige autenticação (verificado em 2026-09-28: `401` em `/v2/chainguard/minio/tags/list`), então a única tag confirmada publicamente é `latest`, sem versão fixa; o ambiente pode mudar entre execuções.

### Option C: RustFS (`rustfs/rustfs:1.0.0`) ou SeaweedFS
- Servidores S3-compatíveis alternativos, com tags versionadas.
- **Pros:** projetos ativos e com licença permissiva (RustFS: Apache-2.0); versão fixável.
- **Cons:** não é MinIO, o que diverge da premissa do enunciado/diagrama; compatibilidade com multipart pré-assinado e `Range` precisa ser validada caso a caso; menos material de referência.

**Recommendation:** **Option A (`pgsty/minio` com tag `RELEASE.*` fixada)** — mantém o MinIO previsto no enunciado com a mesma API S3 e dá uma versão fixa, que o `latest` da Chainguard não oferece. Como a aplicação só fala S3 via AWS SDK v3, trocar de imagem depois (ou ir para S3 real) é mudar a linha `image:` do Compose, sem tocar no código.

**Decision:** A (`pgsty/minio` com tag `RELEASE.*`)
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-28 — Campo Libraries preenchido com os pacotes citados na prosa (IC-1). Rationale: Explicitar libs da prosa.

---

## TD-03: Organização do storage (buckets, chaves e visibilidade)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Vídeos originais e thumbnails precisam de um layout de chaves previsível para a API (pré-cadastro, streaming, download) e para o worker (leitura do original, gravação do thumbnail). A visibilidade dos objetos define se a entrega passa pela API ou sai direto do storage. Depende de TD-10 (streaming).

**Options:**

### Option A: Bucket único privado, chaves por vídeo
- Um bucket (nome via env), chaves `videos/{videoId}/original` e `videos/{videoId}/thumbnail.jpg`. Nenhum objeto público; todo acesso é via API ou URL pré-assinada.
- **Pros:** um só ponto de configuração e de política; todos os artefatos de um vídeo sob um prefixo (limpeza/remoção simples); nenhuma URL do storage exposta sem controle da API, o que respeita visibilidade/rascunho futuros (Fase 04).
- **Cons:** thumbnails também passam pela API (ou por URL pré-assinada), sem cache público direto.

### Option B: Dois buckets — `videos` privado e `thumbnails` público-leitura
- Originais num bucket privado; thumbnails num bucket com policy de leitura anônima.
- **Pros:** thumbnails servidos direto do storage/CDN, sem carga na API — útil para as grades de vídeos das Fases 05/07.
- **Cons:** duas políticas para manter; thumbnail de vídeo rascunho/unlisted fica publicamente acessível para quem souber a chave; mais variáveis de ambiente.

**Recommendation:** **Option A (bucket único privado, chaves por vídeo)** — a Fase 03 não tem grade de vídeos, então o ganho do bucket público ainda não existe, e manter tudo privado evita expor artefatos de vídeos não publicados antes da Fase 04 definir visibilidade. A limpeza de uploads multipart incompletos (abortar via API/`AbortMultipartUpload` ou `mc rm --incomplete`) fica para o plano.

**Decision:** A (bucket único privado, chaves por vídeo)

---

## TD-04: Endpoint interno vs público do storage (contrato de variáveis de ambiente)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** Pela regra de rede do projeto, containers falam com o storage pelo nome do serviço do Compose (ex.: `http://minio:9000`). Mas uma URL pré-assinada entregue a um cliente fora da rede do Compose (navegador no host) precisa apontar para um host que ele resolva (ex.: `http://localhost:9000`), e o host faz parte da assinatura SigV4, então não dá para trocar depois de assinado. É um contrato entre schema Joi, `compose.yaml` e `.env.example`. Depende de TD-05.

**Options:**

### Option A: Dois endpoints — `S3_ENDPOINT` (interno) e `S3_PUBLIC_ENDPOINT` (para assinar URLs)
- A API usa um `S3Client` com o endpoint interno para operações servidor-servidor e um segundo `S3Client` (mesmas credenciais) com o endpoint público apenas para `getSignedUrl`. Nos testes dentro do container, `S3_PUBLIC_ENDPOINT` aponta para `http://minio:9000`.
- **Pros:** respeita a regra "nunca `localhost` entre containers"; funciona igual contra S3 real (em produção os dois endpoints coincidem); testável dentro do container.
- **Cons:** duas variáveis e dois clientes para manter coerentes; o valor muda por contexto (dev no navegador vs testes).

### Option B: Endpoint único com alias de host
- Um só endpoint (ex.: `http://minio:9000`) e o host da máquina recebe uma entrada `minio → 127.0.0.1` no arquivo de hosts.
- **Pros:** uma variável só, um cliente só.
- **Cons:** exige configuração manual na máquina de cada desenvolvedor (fora do repositório); frágil e não documentável pelo Compose.

**Recommendation:** **Option A (dois endpoints)** — mantém a configuração inteira dentro do repositório (Joi + Compose + `.env.example`) e segue a regra de rede do `CLAUDE.md`; o custo é uma variável extra.

**Decision:** A (`S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`)

---

## TD-05: Protocolo de upload de até 10GB

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Arquivos de até 10GB não podem travar a API. O `project-plan.md` (Pontos de Atenção) também pede que o upload "permita retomar em caso de falha de conexão". Um `PUT` único no S3 aceita no máximo 5GB, então 10GB exige multipart (partes de 5MiB a 5GiB, até 10.000 partes). O pré-cadastro do vídeo como rascunho acontece no início do upload. É Cross-layer porque o handshake é executado pelo cliente (frontend futuro) e pela API. Depende de TD-03 e TD-04.

**Options:**

### Option A: Multipart S3 com URLs pré-assinadas, direto ao storage
- `POST` na API cria o vídeo como rascunho + `CreateMultipartUpload` e devolve `uploadId`, tamanho de parte e URLs pré-assinadas de `UploadPart`. O cliente envia as partes direto ao storage e chama a API para concluir (`CompleteMultipartUpload`). Para retomar, a API lista as partes já recebidas (`ListParts`) e reassina as que faltam.
- **Pros:** nenhum byte do vídeo passa pela API, que só troca JSON pequeno; retomada nativa por parte; partes em paralelo; é o mesmo fluxo em MinIO e S3.
- **Cons:** mais chamadas no handshake (iniciar, assinar, concluir); o cliente precisa gerenciar partes e ETags; depende de TD-04 para as URLs serem alcançáveis.

### Option B: tus (upload resumível) via servidor tus na API
- Um servidor tus (`@tus/server` + store S3) montado na API recebe `PATCH` com chunks e os repassa ao storage.
- **Pros:** protocolo padronizado de retomada, com clientes prontos (`tus-js-client`); o cliente só lida com um endpoint.
- **Cons:** todos os 10GB atravessam a API (banda, CPU e conexões longas na API), justamente o que a capability quer evitar; mais uma dependência montada fora do ciclo de vida do Nest.

### Option C: `multipart/form-data` em streaming pela API
- A API recebe o arquivo com busboy e faz stream para o storage (`@aws-sdk/lib-storage`), sem bufferizar em memória.
- **Pros:** um único request para o cliente; implementação conhecida.
- **Cons:** os 10GB passam pela API e prendem uma conexão por upload; sem retomada (falha de rede recomeça do zero), o que contraria o `project-plan.md`; timeouts de proxy em uploads longos.

**Recommendation:** **Option A (multipart S3 pré-assinado)** — é a única opção em que a API nunca recebe os bytes do vídeo e que retoma por parte. Parâmetros propostos para o plano fixar: partes de 64MiB (10GB ≈ 160 partes, bem abaixo do limite de 10.000), URLs de parte expirando em 1h, limite de 10GB validado no início (tamanho declarado) e na conclusão (`HeadObject`).

**Decision:** A (multipart S3 pré-assinado)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-28 — Campo Libraries preenchido com os pacotes citados na prosa (IC-1). Rationale: Explicitar libs da prosa.

---

## TD-06: Gatilho do processamento após o upload

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Quando o último byte chega ao storage, alguém precisa enfileirar o job de processamento e mudar o status do vídeo. Depende de TD-01 e TD-05.

**Options:**

### Option A: Endpoint de conclusão da API enfileira o job
- O cliente chama `complete` na API; a API conclui o multipart, valida o objeto (`HeadObject`: existe, tamanho ≤ 10GB), muda o status para `processing` e publica o job (com `jobId` = id do vídeo).
- **Pros:** fluxo explícito e testável ponta a ponta; a API valida antes de enfileirar; funciona igual em S3 real e MinIO; o `jobId` fixo impede duplicidade se o cliente repetir o `complete`.
- **Cons:** se o cliente enviar todas as partes e nunca chamar `complete`, o vídeo fica em rascunho (o objeto nem existe, pois o multipart não foi concluído).

### Option B: Notificação de evento do storage
- O storage publica `s3:ObjectCreated:CompleteMultipartUpload` numa fila (MinIO suporta targets Redis/AMQP via `mc event add`) e um consumidor enfileira o processamento.
- **Pros:** dispara mesmo sem o cliente chamar a API depois do upload.
- **Cons:** o upload multipart ainda precisa de uma chamada de conclusão de qualquer forma; configuração de notificação específica do storage (diferente entre MinIO e S3/SQS); mais uma peça para testar; a API perde o ponto de validação antes do processamento.

**Recommendation:** **Option A (endpoint de conclusão enfileira)** — no multipart a chamada de conclusão já é obrigatória, então usá-la como gatilho não adiciona passos e mantém a validação e o controle de status na API. Notificações de bucket só se pagariam com upload de PUT único, que TD-05 descarta.

**Decision:** A (endpoint de conclusão enfileira)

---

## TD-07: Como o worker de vídeo roda

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O diagrama separa "Video Worker (FFmpeg)" da API. O processamento é CPU/IO intensivo e não pode disputar recursos com as requisições HTTP. O worker precisa atualizar a tabela de vídeos e gravar no storage. Depende de TD-01.

**Options:**

### Option A: Mesmo código Nest, entrypoint próprio, container separado
- Um `worker.ts` sobe um `NestFactory.createApplicationContext(WorkerModule)` sem HTTP, registrando o `@Processor`. No Compose, um serviço `video-worker` usa a mesma imagem (com FFmpeg instalado) e outro comando.
- **Pros:** reaproveita entidade, repositório, configs e módulo de storage (sem duplicar o modelo de dados); isolamento de processo e de recursos; escala independente (mais réplicas do worker); testável in-process pelos mesmos testes do projeto.
- **Cons:** a imagem da API passa a carregar o FFmpeg também (imagem maior); API e worker precisam ser implantados em versões compatíveis.

### Option B: Processor dentro do processo da API
- O `@Processor` fica registrado no `AppModule` e roda no mesmo processo HTTP.
- **Pros:** zero infraestrutura extra; mais simples de começar.
- **Cons:** FFmpeg e I/O de vídeo competem com as requisições da API, o que contraria "sem impacto na performance"; contradiz o diagrama (worker como container próprio); não escala separadamente.

### Option C: Projeto separado (`video-worker/` com `package.json` próprio)
- Um serviço Node independente, com seu próprio código de acesso a banco e storage.
- **Pros:** isolamento total de dependências e deploy.
- **Cons:** duplica entidade, configuração e cliente de storage (dois modelos de dados que podem divergir); mais um subprojeto para lint, testes e Definition of Done.

**Recommendation:** **Option A (mesmo código, container separado)** — atende o diagrama (worker isolado da API) sem duplicar o modelo de dados; o custo é o FFmpeg na imagem compartilhada.

**Decision:** A (mesmo código, container separado)

---

## TD-08: Integração com FFmpeg e acesso ao arquivo de origem

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa extrair duração e metadados (`ffprobe`) e gerar um thumbnail de um frame (`ffmpeg`). Verificado no npm em 2026-09-28: `fluent-ffmpeg` está **deprecado** ("Package no longer supported"). O arquivo de origem pode ter 10GB. Depende de TD-07.

**Options:**

### Option A: `execFile` de `ffprobe`/`ffmpeg` do sistema, lendo o original por URL pré-assinada interna
- FFmpeg instalado na imagem (pacote da distro). O worker gera uma URL pré-assinada de `GetObject` (endpoint interno) e passa como entrada; `ffprobe -print_format json -show_format -show_streams` devolve os metadados; `ffmpeg -ss <t> -frames:v 1` gera o JPEG, que é enviado ao storage.
- **Pros:** sem dependência npm deprecada; saída JSON tipável; o FFmpeg lê via HTTP com `Range`, baixando só o necessário (cabeçalho + região do frame) em vez de 10GB; sem disco temporário grande no worker.
- **Cons:** tipagem e tratamento de erro de processo externo feitos à mão; arquivos com `moov` no fim podem exigir mais leituras por `Range`.

### Option B: `fluent-ffmpeg`
- Wrapper Node sobre os binários com API encadeada.
- **Pros:** API conhecida, muitos exemplos.
- **Cons:** pacote deprecado e sem manutenção, um risco que a regra de docs do projeto (seguir a doc oficial da versão instalada) não consegue cobrir.

### Option C: `execFile` após baixar o original para disco temporário
- O worker baixa o objeto inteiro para um volume temporário e roda `ffprobe`/`ffmpeg` localmente.
- **Pros:** leitura local, previsível para qualquer container de vídeo.
- **Cons:** até 10GB de download e de disco por job; processamento bem mais lento; exige volume dimensionado e limpeza garantida.

**Recommendation:** **Option A (`execFile` + URL pré-assinada interna)** — evita a dependência deprecada e não transfere 10GB por job, porque o FFmpeg lê só as faixas de que precisa. Se algum formato se mostrar problemático via HTTP, a Option C serve de fallback sem mudar o contrato do job.

**Decision:** A (`execFile` + URL pré-assinada interna)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-28 — Campo Libraries preenchido com os pacotes citados na prosa (IC-1). Rationale: Explicitar libs da prosa.
- 2026-09-28 — Metadados persistidos em colunas próprias da entidade de vídeo: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable), `container`, `bitrate`, `size_bytes` — sem campo JSON. Rationale: AMB-1 do /plan-validate 03 — a capability não enumerava os metadados.
- 2026-09-28 — Thumbnail gerada no instante de 10% da duração (`-ss`); vídeos com duração < 1s usam o frame 0. Rationale: AMB-2 do /plan-validate 03 — regra de seleção do frame não estava definida.

---

## TD-09: Estratégia de URL única por vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de uma URL curta e única que nunca conflite com outra (`project-plan.md`, Pontos de Atenção). O identificador aparece nas rotas de streaming/download agora e nas rotas do frontend depois (Fase 05). Verificado no npm: `nanoid` 6.x é só ESM (`"type": "module"`), enquanto o backend compila para CommonJS e testa com ts-jest.

**Options:**

### Option A: ID aleatório curto em base64url (`node:crypto`), coluna `UNIQUE` + retry
- 11 caracteres base64url gerados de bytes aleatórios (`crypto.randomBytes`), ≈ 66 bits de entropia; coluna `slug` com constraint `UNIQUE`; em colisão, gera outro (mesmo padrão de retry já usado para nickname de canal).
- **Pros:** curto e não sequencial (não permite enumerar vídeos, o que importa para unlisted na Fase 04); sem dependência nova; unicidade garantida pelo banco, não só pela probabilidade.
- **Cons:** precisa do laço de retry em colisão (raríssima); a URL não é legível.

### Option B: Usar o UUID do vídeo na URL
- A própria PK (`uuid`) é o identificador público.
- **Pros:** zero código novo; único por construção.
- **Cons:** 36 caracteres, longe de "URL curta"; expõe a chave primária interna.

### Option C: Sqids sobre um contador sequencial
- Uma coluna sequencial codificada com Sqids gera IDs curtos.
- **Pros:** curto e sem colisão por construção.
- **Cons:** o ID é reversível para o sequencial (enumerável), o que atrapalha vídeos unlisted; exige coluna/sequência extra além da PK UUID.

**Recommendation:** **Option A (base64url aleatório + `UNIQUE`)** — atende "curta" e "sem conflito" com a garantia do banco, não é enumerável (pensando na visibilidade unlisted da Fase 04) e dispensa dependência nova, evitando o `nanoid` só-ESM num projeto CommonJS.

**Decision:** A (base64url aleatório + `UNIQUE`)

---

## TD-10: Streaming e download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** O player precisa começar a tocar sem baixar o arquivo inteiro e avançar para qualquer ponto (seek), o que em HTTP significa requisições `Range` respondidas com `206 Partial Content`. O download precisa do mesmo arquivo com `Content-Disposition: attachment`. Detalhe: uma tag `<video>` não envia o header `Authorization` exigido pelo guard JWT atual. O diagrama indica "Frontend → Object Storage: Streams". Depende de TD-03.

**Options:**

### Option A: Endpoint da API com `Range` → `206`, repassando o stream do storage
- `GET /videos/{slug}/stream` lê o header `Range`, chama `GetObject` com o mesmo `Range` e faz pipe da resposta (`206`, `Content-Range`, `Accept-Ranges: bytes`); `GET /videos/{slug}/download` faz o mesmo com `attachment`.
- **Pros:** bucket continua privado e a regra de acesso fica na API (pronta para visibilidade/rascunho nas Fases 04/05); comportamento `206` testável ponta a ponta com supertest; nada é bufferizado, pois é stream direto.
- **Cons:** o tráfego de vídeo passa pela API (banda e conexões abertas); diverge do diagrama, que mostra o frontend lendo direto do storage; em produção pediria CDN à frente.

### Option B: API responde `302` para uma URL pré-assinada de `GetObject`
- A API valida o acesso e redireciona; o navegador faz as requisições `Range` direto ao storage, que responde `206`.
- **Pros:** alinhado ao diagrama; a banda de vídeo não passa pela API; o storage/S3 já implementa `Range` corretamente.
- **Cons:** URLs de acesso temporário vazam para o cliente (compartilháveis até expirar); depende de TD-04 (endpoint público); nos testes o `206` é verificado no storage, não na API.

### Option C: HLS (transcodificação em segmentos)
- O worker transcodifica para HLS (`.m3u8` + segmentos) e o player consome os segmentos.
- **Pros:** streaming adaptativo por qualidade; padrão de plataformas de vídeo.
- **Cons:** transcodificação completa de até 10GB por vídeo (custo e tempo muito maiores); dobra o armazenamento; vai além do escopo da fase (que pede metadados e thumbnail, não transcodificação).

**Recommendation:** **Option A (API com `Range`/`206`)** — mantém o storage privado e a autorização centralizada, e torna o requisito "streaming sem download completo" verificável por teste e2e na própria API. A divergência com o diagrama é intencional para esta fase: a Option B é a evolução natural quando houver CDN, sem mudar as rotas públicas. Como a tag `<video>` não envia `Authorization`, os endpoints de streaming/download de vídeos `ready` seriam `@Public()`, protegidos pelo slug não enumerável (TD-09); o controle de visibilidade fica para a Fase 04.

**Decision:** A (API com `Range`/`206`)
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-28 — Campo Libraries preenchido com os pacotes citados na prosa (IC-1). Rationale: Explicitar libs da prosa.
- 2026-09-28 — A Fase 03 expõe a thumbnail: `GET /videos/{slug}/thumbnail` `@Public()` para vídeos `ready`, servida pela API a partir do bucket privado (mesmo padrão de stream do storage). Rationale: AMB-2 do /plan-validate 03 — fronteira de entrega da thumbnail entre Fase 03 e 04 estava indefinida.

---

## TD-11: Ciclo de status do vídeo e tratamento de falhas

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O vídeo nasce como rascunho no início do upload, passa a processando quando o upload é concluído e termina pronto ou com erro. É preciso definir onde o estado vive, o que acontece em falhas transitórias vs definitivas e como o erro fica visível. A Fase 04 introduzirá "rascunho → publicação" e visibilidade, que não podem colidir com este ciclo. Depende de TD-01 e TD-06.

**Options:**

### Option A: Coluna `status` única (`draft → processing → ready | failed`) + `failure_reason`, com retry no job
- Enum no Postgres. `draft` no pré-cadastro; `processing` no `complete`; o worker marca `ready` com duração/metadados/thumbnail ou, após esgotar os retries (ex.: 3 tentativas com backoff exponencial), `failed` com `failure_reason`. Falha definitiva (ffprobe diz que não é vídeo) usa `UnrecoverableError` e vai direto a `failed`. A publicação da Fase 04 fica em colunas próprias (ex.: visibilidade), não neste enum.
- **Pros:** estado único e fácil de consultar; o motivo da falha fica no banco; separa claramente "estado técnico do arquivo" de "estado editorial" (Fase 04); transições atualizam o registro de forma idempotente (o worker só age se o status for `processing`).
- **Cons:** o enum precisa ser estendido por migration se surgir um estado novo; não guarda histórico de tentativas (fica na fila).

### Option B: Duas colunas — `upload_status` e `processing_status`
- Estado do upload e estado do processamento separados.
- **Pros:** granularidade por etapa.
- **Cons:** combinações inválidas possíveis (ex.: processamento `ready` com upload `pending`), que exigem regras extras; mais complexo de consultar sem ganho real nesta fase.

### Option C: Coluna `status` + tabela de tentativas de processamento
- Como a Option A, mas cada tentativa gera uma linha (início, fim, erro).
- **Pros:** histórico auditável de reprocessamentos.
- **Cons:** tabela e escrita extras para uma informação que a fila (BullMQ) já guarda por job; escopo além do pedido pela fase.

**Recommendation:** **Option A (status único + `failure_reason`, retry no job)** — cobre exatamente o ciclo pedido (rascunho → processando → pronto/erro), deixa a falha visível no banco e preserva espaço para a Fase 04 modelar publicação sem reaproveitar o enum técnico.

**Decision:** A (status único + `failure_reason`)

---

## TD-12: Estratégia de testes com a infraestrutura real (storage, fila, FFmpeg)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** A política do projeto proíbe mockar o que dá para testar com a infra do Compose (`*.integration-spec.ts` e `*.e2e-spec.ts` usam serviços reais). Os testes rodam dentro do container `nestjs-api`, que hoje não tem FFmpeg. É preciso decidir como os testes exercitam fila + worker + storage e de onde vem o vídeo de teste. Depende de TD-07 e TD-08.

**Options:**

### Option A: Worker in-process nos testes + FFmpeg na imagem de dev + fixture gerado pelo FFmpeg
- Integração/e2e sobem o módulo do worker dentro do processo de teste (mesmo código do TD-07), contra Redis/storage/Postgres reais do Compose; a imagem de dev ganha FFmpeg; o vídeo de teste é gerado em setup (`ffmpeg -f lavfi testsrc`, poucos KB) com duração conhecida para asserção.
- **Pros:** exercita fila, storage e FFmpeg de verdade; determinístico (o teste controla o worker e espera o job terminar); sem binário de vídeo versionado no git; valores esperados (duração, resolução) conhecidos.
- **Cons:** testes de processamento ficam mais lentos (segundos por job); a imagem de dev fica maior.

### Option B: Teste e2e depende do container `video-worker` rodando e faz polling no banco
- O teste envia o vídeo e espera o container real do worker mudar o status.
- **Pros:** exercita exatamente a topologia de produção.
- **Cons:** acoplado ao estado de outro container (worker parado ou com código antigo gera falsos negativos); polling com timeout é propenso a flakiness; concorre com o worker de dev pelos mesmos jobs.

### Option C: Mockar FFmpeg e fila nos testes
- `execFile` e `Queue` substituídos por mocks.
- **Pros:** testes rápidos e isolados.
- **Cons:** viola a política do projeto e o enunciado ("não mocke o que dá para testar de verdade"); não prova que a integração funciona. Cabe só em testes unitários de regras de status.

**Recommendation:** **Option A (worker in-process + FFmpeg na imagem + fixture gerado)** — testa a integração real de ponta a ponta sem depender do estado de outro container, e mantém os mocks restritos aos `*.spec.ts` unitários, como mandam as regras do projeto. Para os testes não concorrerem com o worker de dev, o plano deve prever um nome de fila (ou prefixo) próprio para testes.

**Decision:** A (worker in-process + FFmpeg + fixture gerado)

---

## TD-13: Formatos de vídeo aceitos e transcodificação para reprodução no browser

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** TD-10 transmite o **arquivo original** com `Range`/`206`, e o processamento (TD-08) só extrai metadados e thumbnail. Hoje, portanto, um vídeo pode chegar a `ready` sem tocar na tag `<video>`. Segundo o MDN (consultado em 2026-09-28), só MP4, WebM e Ogg são containers suportados em todos os browsers; MOV/QuickTime está deprecado e MKV/AVI/MPEG-TS não constam como formatos web. Entre os codecs, H.264 é o único universal; VP8/VP9 têm suporte amplo; AV1 depende de decoder de hardware no Safari; HEVC depende de hardware/SO (e é o padrão das câmeras de iPhone, em MOV); MPEG-4 Part 2 e Theora estão obsoletos. A lista de formatos aceitos é contrato entre backend (validação no pré-cadastro e no worker), frontend (`accept` do seletor de arquivo e mensagem de erro) e o código de erro de domínio (`phase-02-auth/TD-07`). Depende de TD-05, TD-08, TD-10 e TD-11.

**Options:**

### Option A: Aceitar qualquer vídeo reconhecido pelo `ffprobe` e transmitir o original
- O worker só exige que o `ffprobe` encontre um stream de vídeo; qualquer container/codec vira `ready`, e o `Content-Type` do streaming é derivado do container detectado.
- **Pros:** zero lógica extra; aceita todo arquivo que o usuário enviar; o download devolve exatamente o original.
- **Cons:** `ready` não garante reprodução (MKV, AVI, HEVC e MPEG-4 Part 2 falham no player sem aviso); a capability "Reprodução via streaming" fica sem garantia verificável; o problema aparece só na Fase 05 (player).

### Option B: Allowlist de combinações compatíveis com browser, validada em duas camadas, sem transcodificação
- Aceita apenas combinações que tocam nos browsers principais: container MP4 ou WebM; vídeo H.264, VP8 ou VP9 (AV1 fica a critério do plano); áudio AAC, MP3, Opus, Vorbis ou sem áudio. Camada 1, no pré-cadastro (TD-05): rejeita cedo pelo MIME/extensão declarados, antes de subir até 10GB. Camada 2, no worker: a checagem autoritativa usa os campos `format_name`/`codec_name` do `ffprobe`, que já roda (TD-08); fora da lista, `UnrecoverableError` → `failed` com `failure_reason` de formato não suportado (TD-11).
- **Pros:** `ready` passa a significar "toca no browser"; custo quase nulo (reusa o `ffprobe` e a leitura parcial por `Range`); mantém o original para download; coerente com TD-10, que descartou transcodificação nesta fase; testável com fixtures gerados (TD-12).
- **Cons:** rejeita formatos comuns (MOV/HEVC do iPhone, MKV), e o usuário precisa converter antes; a allowlist precisa ser mantida em sincronia entre backend e frontend; o `ffprobe` reporta MP4/MOV e MKV/WebM pelo mesmo demuxer, então a regra combina container e codecs.

### Option C: Transcodificar tudo para MP4 (H.264/AAC, `+faststart`) no worker
- Todo upload é recodificado para um formato canônico; o streaming passa a servir o arquivo transcodificado.
- **Pros:** aceita qualquer entrada; reprodução garantida em todos os browsers; `moov` no início melhora o início da reprodução.
- **Cons:** horas de CPU para arquivos de até 10GB; lê o original inteiro (anula a leitura parcial de TD-08) e exige disco temporário, pois `+faststart` precisa de saída com seek; dobra o armazenamento, ou troca o original do download; processamento muito mais longo; é o mesmo custo que TD-10 usou para descartar HLS nesta fase.

### Option D: Híbrido — allowlist + remux sem recodificar quando só o container é incompatível
- Como a Option B, mas se os codecs são compatíveis e o container não (ex.: MOV ou MKV com H.264/AAC), o worker faz `ffmpeg -c copy` para MP4 e serve o resultado; codecs incompatíveis (HEVC, MPEG-4 Part 2) continuam rejeitados.
- **Pros:** aceita mais arquivos sem o custo de CPU da recodificação; `ready` continua garantindo reprodução.
- **Cons:** o remux lê e grava o arquivo inteiro (até 10GB de I/O e disco/armazenamento extra); dois artefatos por vídeo, ou substituição do original; ramo a mais no worker e nos testes; ainda rejeita HEVC, que é o caso mais comum (iPhone).

**Recommendation:** **Option B (allowlist validada no pré-cadastro e no worker, sem transcodificação)** — torna "Reprodução via streaming" verificável (`ready` ⇒ toca no browser) reusando o `ffprobe` de TD-08, sem transferir 10GB por job e sem reabrir a decisão de TD-10 de não transcodificar nesta fase. As Options C/D ficam como evolução natural (remux ou transcodificação como etapa extra do mesmo job) sem mudar o ciclo de status (TD-11) nem as rotas de streaming (TD-10).

**Decision:** B (allowlist MP4/WebM + H.264/VP8/VP9, validada no pré-cadastro e no worker, sem transcodificação)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia da fila de processamento | A (BullMQ + Redis) | A (BullMQ + Redis) |
| TD-02 | Repo-wide | Imagem do object storage S3-compatível no Compose | A (`pgsty/minio` com tag `RELEASE.*`) | A (`pgsty/minio` com tag `RELEASE.*`) |
| TD-03 | Backend | Organização do storage (buckets, chaves e visibilidade) | A (bucket único privado, chaves por vídeo) | A (bucket único privado, chaves por vídeo) |
| TD-04 | Backend | Endpoint interno vs público do storage | A (`S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`) | A (`S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`) |
| TD-05 | Cross-layer | Protocolo de upload de até 10GB | A (multipart S3 pré-assinado) | A (multipart S3 pré-assinado) |
| TD-06 | Backend | Gatilho do processamento após o upload | A (endpoint de conclusão enfileira) | A (endpoint de conclusão enfileira) |
| TD-07 | Backend | Como o worker de vídeo roda | A (mesmo código, container separado) | A (mesmo código, container separado) |
| TD-08 | Backend | Integração com FFmpeg e acesso ao arquivo | A (`execFile` + URL pré-assinada interna) | A (`execFile` + URL pré-assinada interna) |
| TD-09 | Cross-layer | Estratégia de URL única por vídeo | A (base64url aleatório + `UNIQUE`) | A (base64url aleatório + `UNIQUE`) |
| TD-10 | Cross-layer | Streaming e download | A (API com `Range`/`206`) | A (API com `Range`/`206`) |
| TD-11 | Backend | Ciclo de status do vídeo e tratamento de falhas | A (status único + `failure_reason`) | A (status único + `failure_reason`) |
| TD-12 | Backend | Estratégia de testes com infraestrutura real | A (worker in-process + FFmpeg + fixture gerado) | A (worker in-process + FFmpeg + fixture gerado) |
| TD-13 | Cross-layer | Formatos de vídeo aceitos e transcodificação | B (allowlist em duas camadas, sem transcodificação) | B (allowlist em duas camadas, sem transcodificação) |
