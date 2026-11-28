# Página de status do BarberPro

Página pública de disponibilidade (estado atual, barras de 90 dias e histórico
de incidentes) alimentada por monitoramento **real**, hospedada **fora da VPS**
principal.

Esta pasta é só a fonte: ela vive no monorepo para revisão, mas **não faz parte
do workspace pnpm/Turborepo** (não tem `package.json`, não entra em
`pnpm-workspace.yaml`, sem dependências nem build). Em produção ela é copiada
para o repositório público `fdeibson/barbearia-status`.

## Arquitetura

```
GitHub Actions (cron */5)                          GitHub Pages
┌───────────────────────────────┐                 ┌────────────────────────┐
│ monitor/check.mjs             │  commit         │ site/index.html        │
│  GET /login                   │ ───────────────▶│ site/data/status.json  │◀── navegador
│  GET /b/barbearia-teste       │  + deploy Pages │ site/data/incidents-   │
│  GET /api/health              │                 │   manual.json          │
└──────────────┬────────────────┘                 └────────────────────────┘
               │ HTTPS público
               ▼
   barbearia.hostcapixaba.com.br (VPS: Apache → Docker)
```

- **`apps/web/src/app/api/health/route.ts`** (no app principal): `GET`, sem
  auth, sem cache. Faz `SELECT 1` no banco com limite de 3s e responde
  `{ status: "ok"|"degraded", checks: { app, database }, time }` — 200 se ok,
  503 se o banco falhar. Nunca expõe mensagem de erro, versão ou env.
- **`monitor/check.mjs`**: Node 20+, zero dependências. Uma rodada de
  verificações por execução, acumulada em `site/data/status.json`.
  - timeout de 10s por requisição; em falha, espera 5s e tenta de novo antes
    de registrar (reduz falso positivo);
  - resultado por verificação: `up`, `degraded` (respondeu certo mas levou
    mais de 5s), `down` ou `unknown`;
  - **`/api/health` antes do primeiro deploy**: enquanto o endpoint nunca
    respondeu JSON de health com `status: "ok"`, qualquer falha sem JSON
    válido (ex.: 404 em HTML) é `unknown`, não `down`. Quando responde ok pela
    primeira vez, grava `firstSeenOkAt`; a partir daí falha é `down`. Um JSON
    de health válido acusando problema (`503` + `status: "degraded"`) é `down`
    sempre — o endpoint claramente existe e o banco está fora;
  - agrega por dia civil de Brasília (`America/Sao_Paulo`) mantendo 90 dias, e
    guarda as últimas 50 verificações brutas;
  - incidentes automáticos: abre com **2 `down` seguidos** (o início é a
    primeira das duas), resolve no primeiro `up` ou `degraded` (respondeu).
    `unknown` não abre nem resolve. Mantém 1 ano de incidentes resolvidos.
- **`monitor/lib.mjs`**: funções puras (classificação, agregação, janela,
  incidentes). **`site/assets/status-core.mjs`**: lógica compartilhada com a
  página (datas em Brasília, % de disponibilidade, detecção de dado velho,
  estado geral) — fica dentro de `site/` porque o navegador precisa importar.
- **`site/`**: HTML/CSS/JS estático sem build. Busca `data/status.json` (com
  `?t=` para furar cache) a cada 60s.

### Regras de honestidade da página

- Dia sem nenhuma verificação conclusiva = barra cinza **"Sem dados"** (nunca
  verde).
- % da janela é calculado **só sobre os dias com dados**, e a página diz sobre
  quantos ("calculado sobre N dias com dados"). `unknown` não entra na conta;
  `degraded` conta como disponível.
- Última verificação há mais de **30 min** → aviso de dados desatualizados e
  estado geral/serviços como **"Desconhecido"**.
- `status.json` ausente → "Desconhecido — o monitoramento ainda não iniciou".
- Percentuais são truncados (99,999% aparece 99,99%, nunca 100,00%).

### Formato de `site/data/status.json`

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-17T10:17:01.000Z",   // fim da última rodada
  "monitoringSince": "2026-09-17T10:13:13.553Z",
  "services": [
    {
      "id": "web", "name": "Aplicação web", "description": "…", "type": "http",
      "url": "https://barbearia.hostcapixaba.com.br/login",
      "firstSeenOkAt": null,                     // só relevante para type "health"
      "current": { "state": "up", "checkedAt": "…", "httpStatus": 200, "latencyMs": 741 },
      "daily": { "2026-09-17": { "up": 3, "down": 0, "degraded": 0, "unknown": 0, "total": 3 } },
      "recent": [ { "at": "…", "outcome": "up", "httpStatus": 200, "latencyMs": 741 } ]
    }
  ],
  "incidents": [
    { "id": "web-…", "serviceId": "web", "serviceName": "Aplicação web",
      "startedAt": "…", "endedAt": null, "status": "open", "auto": true,
      "description": "Aplicação web ficou indisponível — 2 verificações seguidas falharam (…)." }
  ]
}
```

## Por que hospedagem independente

A página existe para responder "o BarberPro está fora?" justamente quando a VPS
está com problema. Se ela rodasse na mesma VPS (ou fosse checada de dentro
dela), cairia junto e não diria nada. Aqui tanto quem verifica (runners do
GitHub Actions) quanto quem serve a página (GitHub Pages) estão fora da VPS.

## Limitações conhecidas

- **Frequência**: o cron mínimo do GitHub Actions é 5 min e execuções agendadas
  **podem atrasar muito ou ser puladas** em horários de carga. Por isso a
  página mostra a hora real da última verificação e passa a "Desconhecido"
  após 30 min sem dados. Uma queda menor que o intervalo entre rodadas pode
  não aparecer.
- **Ponto de vista único**: as verificações saem da rede do GitHub (EUA, na
  maioria). Um problema só de rota no Brasil pode não ser visto, e uma falha de
  rede do lado do GitHub pode gerar falso `down` (a repetição após 5s e a regra
  de 2 falhas seguidas mitigam).
- **O que é verificado**: só URLs públicas — `/login` e `/b/barbearia-teste`
  respondendo 200 e `/api/health` confirmando o banco. Não testa login,
  agendamento ponta a ponta, envio de e-mail/WhatsApp, cron interno etc.
- **Repositório público**: expõe apenas o resultado dessas verificações de
  URLs que já são públicas (código HTTP, latência, horário). Nenhum segredo é
  necessário nem deve ser adicionado ao repositório de status.
- **Crescimento do histórico git**: cada rodada com mudança gera um commit
  (~288/dia). O arquivo é pequeno e o git comprime bem, mas se o repositório
  ficar grande dá pra reescrever o histórico mantendo só o último
  `status.json` (os dados agregados ficam no próprio arquivo, não no histórico).
- **Workflows agendados em repositórios públicos** são desativados pelo GitHub
  após 60 dias sem atividade no repositório; os commits do próprio monitor
  contam como atividade, mas se o monitor parar por muito tempo, reative em
  *Actions*.
- **Domínio próprio depende da VPS**: ver "Domínio próprio" abaixo.

## Rodando localmente

```bash
# testes (a partir da raiz do monorepo)
node --test status-page/monitor/lib.test.mjs

# uma rodada real contra produção, gravando num arquivo de rascunho
node status-page/monitor/check.mjs /tmp/status/status.json

# simular serviço fora (NUNCA commitar esse arquivo)
STATUS_BASE_URL=http://127.0.0.1:9 node status-page/monitor/check.mjs /tmp/status-sim/status.json

# ver a página: qualquer servidor estático apontando para status-page/site
npx http-server status-page/site -p 8080 -c-1
```

> Use o caminho do arquivo de teste explicitamente: sem argumento o monitor
> grava em `site/data/status.json`, que é o arquivo publicado.
> Em Node 22+ `node --test status-page/monitor/` não funciona (trata o
> argumento como padrão de arquivo); passe o arquivo de teste.

Variáveis: `STATUS_DATA_FILE` (caminho do JSON, se não vier como argumento),
`STATUS_BASE_URL` (troca o host verificado; a URL exibida continua a de
produção), `STATUS_SERVICES` (outro `services.json`).

## Em produção hoje (2026-09-17)

**Principal — independente da VPS**: repositório público
`fdeibson/barbearia-status` (criado com autorização explícita do dono da
conta), GitHub Pages por Actions, domínio `https://status.hostcapixaba.com.br`
(CNAME `status` → `fdeibson.github.io.` no DNS do cPanel, HTTPS forçado) e
`https://fdeibson.github.io/barbearia-status/`. Lá existe `site/CNAME`, que
não fica neste monorepo.

**Gatilhos**: o agendador do GitHub não disparou neste repositório; quem
dispara é um push na branch `tick` feito por `monitor/tick.sh` agendado na VPS
(a cada 5 min) e no Windows (a cada 10 min), cada um com deploy key própria
(escrita só no repositório de status). `monitor/should-run.mjs` pula a rodada
se o status publicado tiver menos de 4 min. Detalhes em DEPLOY.md seção 10.

**Secundária — mesma VPS**: a mesma página em
`https://barbearia.hostcapixaba.com.br/status`:

- **Site**: cópia idêntica de `site/` em `apps/web/public/status`
  (redireciona pra `/status/index.html`). `apps/web/src/lib/status-page-sync.test.ts`
  falha se a cópia divergir desta pasta — edite aqui e copie pra lá (e pro
  repositório público).
- **Dados**: `GET /status/data/status.json` lê `STATUS_DATA_DIR`
  (`/opt/barbearia/status-data` montado somente leitura no container).
  Sem arquivo → 404 → a página mostra "Desconhecido".
- **Monitor**: `monitor/run-on-vps.sh` no crontab do `wwhost`, a cada 5 min,
  num container `node:22-alpine` descartável, batendo no domínio público.

A secundária depende da VPS (com a VPS fora, não há verificação nesse
intervalo e ele aparece como "Sem dados"); a principal não.

## Publicação (repositório `fdeibson/barbearia-status`)

1. Criar o repositório **público** `fdeibson/barbearia-status` (branch `main`).
2. Copiar, preservando esta estrutura na raiz do repositório novo:
   ```
   status-page/site/            → site/
   status-page/monitor/         → monitor/
   status-page/github/workflow.yml → .github/workflows/monitor.yml
   status-page/github/pages.yml    → .github/workflows/pages.yml
   status-page/README.md        → README.md
   ```
   Não copiar nenhum `status.json` gerado localmente: o primeiro run cria o
   arquivo real.
3. *Settings → Pages → Build and deployment → Source: **GitHub Actions***.
4. *Settings → Actions → General → Workflow permissions*: deixar o padrão
   (os workflows declaram `contents: write`/`pages: write` por job). Nenhum
   secret é necessário.
5. Push para `main` → roda `pages.yml` (testes + publica a página, ainda
   "monitoramento não iniciou"). Em *Actions → Monitor → Run workflow* dispare
   a primeira verificação manualmente; depois o cron assume.
6. A página fica em `https://fdeibson.github.io/barbearia-status/`.

### Por que o deploy fica dentro do workflow do monitor

Commits feitos com o `GITHUB_TOKEN` **não disparam** outros workflows. Se o
Pages dependesse de um `on: push` (ou de "Deploy from a branch", que tem limite
de ~10 builds/hora), os dados novos não seriam publicados de forma confiável.
Por isso `monitor.yml` publica o `site/` recém-atualizado no mesmo run, e
`pages.yml` cobre só as mudanças feitas por pessoas.

## Como adicionar um serviço

Adicionar uma entrada em `monitor/services.json`:

```json
{
  "id": "novo-servico",
  "name": "Nome exibido",
  "description": "Uma linha explicando o que é",
  "type": "http",
  "path": "/caminho",
  "expectStatus": 200
}
```

- `id`: estável, só letras/números/hífen — o histórico é chaveado por ele
  (trocar o `id` = começar do zero).
- `type`: `"http"` (basta o código esperado) ou `"health"` (exige JSON no
  formato do `/api/health` com `status: "ok"`, e aplica a regra do
  `firstSeenOkAt`).
- `path`: relativo ao `baseUrl` do arquivo. Use só URLs públicas, sem token.

Remover um serviço do arquivo tira ele da página e fecha qualquer incidente
aberto dele.

## Nota manual de incidente

Para comunicar algo que o monitor não vê (manutenção programada, problema só no
envio de WhatsApp etc.), editar `site/data/incidents-manual.json` e fazer push.
A página mescla com os incidentes automáticos (abertos primeiro, depois do mais
recente para o mais antigo).

```json
[
  {
    "id": "2026-09-20-manutencao",
    "title": "Manutenção programada do banco de dados",
    "serviceName": "API e banco de dados",
    "severity": "partial",
    "description": "Janela de manutenção; o sistema pode ficar lento por alguns minutos.",
    "startedAt": "2026-09-20T02:00:00-03:00",
    "endedAt": "2026-09-20T02:30:00-03:00"
  }
]
```

| Campo | Obrigatório | Descrição |
|---|---|---|
| `startedAt` | sim | ISO 8601 com fuso. Entradas sem data válida são ignoradas. |
| `endedAt` | não | ISO 8601; `null`/ausente = "Em andamento". |
| `title` | não | Título; sem ele usa "Indisponibilidade: <serviceName>". |
| `serviceName` | não | Texto livre do serviço afetado. |
| `description` | não | Texto exibido (sem HTML — é renderizado como texto puro). |
| `severity` | não | `"partial"` (padrão) ou `"major"` — cor do selo enquanto aberto. |
| `id` | não | Identificador livre. |

Notas manuais **não** alteram o estado atual nem as barras — esses vêm só das
verificações reais.

## Domínio próprio (`status.hostcapixaba.com.br`) — opcional

Não há arquivo `CNAME` de propósito: com `CNAME` mas sem DNS configurado, o
GitHub redireciona o endereço `github.io` para um domínio que não resolve e a
página some. Ordem segura:

1. No DNS de `hostcapixaba.com.br`, criar
   `status  CNAME  fdeibson.github.io.`
2. Esperar propagar (`nslookup status.hostcapixaba.com.br`).
3. Criar `site/CNAME` contendo só `status.hostcapixaba.com.br` e fazer push.
4. *Settings → Pages → Custom domain*: `status.hostcapixaba.com.br`, aguardar a
   verificação e marcar **Enforce HTTPS**.
5. (Recomendado) Verificar o domínio na conta do GitHub (*Settings → Pages →
   Verified domains*) para impedir que outra conta o reivindique.

**Atenção:** os servidores de nome de `hostcapixaba.com.br` são
`ns1/ns2.hostcapixaba.com.br`, **na mesma VPS**. Se a VPS cair, o domínio
próprio pode deixar de resolver junto (depois que o TTL expirar). O endereço
**`https://fdeibson.github.io/barbearia-status/`** é o fallback totalmente
independente — divulgue os dois (ex.: no rodapé do app e na página de suporte).
Para o domínio próprio ficar realmente independente, o DNS precisaria ir para
um provedor externo (ex.: Cloudflare) ou ter um NS secundário fora da VPS.
