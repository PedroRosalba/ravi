---
name: pages
description: |
  Publica uma página no host default do projeto (rota, não um host novo). Use quando precisar:
  - Criar, publicar ou hospedar uma página, landing ou relatório
  - Subir HTML e obter um URL no host do projeto
  - page, pages, HTML, rota, URL, publish, hospedar, landing, relatório
  Você mesmo publica com `ravi pages ship … --execute`.
  Não use para o ledger genérico de artifacts (isso é a skill artifacts).
  Não crie um host *.ravi.page por página.
---

# Ravi Pages

**Você mesmo publica** com `ravi pages ship`. Não peça a outro agent para publicar por você: não existe agent especialista em Pages. Se `pages` for negado por permissão, peça `execute:group:pages` ao operador ou reporte a tarefa como bloqueada.

Um projeto tem um host default (`<orgSlug>-<projectSlug>.ravi.page`). Páginas são rotas nesse host. A URL é `https://<host><rota>`. Domínio custom é um binding em cima desse host.

Não crie um site por página. Não crie um host por página. `--title` é o título da página. Ele não vira slug de host.

`ravi pages ship` publica uma rota no host default. Um comando. Não orquestre `create` + `publish`. Não use `artifacts publish` para hospedar HTML.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (`SITE_NOT_FOUND`, `ROUTE_NOT_FOUND`, auth/provider).
- `2` erro de uso: falta `--title`, `--body`/`--html`/`--dir` ausentes ou conflitantes, arquivo/diretório inexistente, slug reservado (`ravi`, `ravi-*`) no `ship` posicional ou no `create`, fonte local inexistente no `publish`. Esses erros saem antes do freio.
- `3` freio de escrita — não é erro. Nada foi enviado/exposto; o envelope traz `dryRun:true` e `plan`. Revise e repita com `--execute`.

**Freio de escrita do ship:** dry-run por default. Sem `--execute` nada sobe e nenhum release é criado (exit 3 + plano). Com `--execute` o ship publica. O mesmo freio vale para `pages create` e `pages publish`. `--execute` nesses três não é no-op.

`--visibility public` vale no mesmo `ship`. Ainda precisa de `--execute`. Sem `--execute` a chamada continua dry-run, mesmo com `public`.

O freio também continua em `password set/remove`, `domains`, `assertion audiences set/remove` e `visibility`/`update` para `public`. Reduzir visibility (`private` / `protected_link`) grava na hora.

`--json` de sucesso do ship. `slug` é o host do projeto. `route` é a página. O campo `site` é o registro desse host:

```json
{ "url": "https://acme-proj.ravi.page/relatorio", "site": {}, "slug": "acme-proj", "route": "/relatorio", "visibility": "private", "artifactId": "art_xxx" }
```

O JSON também traz `success` e `commentFollow`. O plano do dry-run descreve a forma da fonte (`kind` e tamanho do body; o path sai redigido). Não inclui o HTML e não deriva um host a partir de `--title`.

Checklist:

- Publiquei eu mesmo com `ravi pages ship … --execute`, sem pedir a outro agent?
- Numa falha, li `error.code`/`suggestedAction` e parei, sem repetir `--execute` variando a entrada?
- Usei `--visibility public` só porque pediram uma URL aberta?
- Publiquei no host default do projeto, sem criar um `*.ravi.page` a partir do título?
- Listei as rotas antes de escolher `--route`?
- Usei só `ravi pages ship` para obter a URL, sem `create` + `publish`?
- Tratei exit 3 como freio de ship/create/publish (e de password/domains/assertion audiences set|remove/visibility→public)?
- Se a rota `/` ficou private explícita, usei `pages visibility <host> public --route / --execute` em vez de re-ship?

## Happy path: projeto → host → rota

```bash
ravi pages published --project <projeto> --json
ravi pages ship --project <projeto> --title "Relatório semanal" --route /relatorio --body "<h1>OK</h1>" --json --execute
ravi pages ship --title "Relatório semanal" --body "<h1>OK</h1>" --json --execute
ravi pages ship --project <projeto> --title "Landing" --route / --html ./landing.html --visibility public --json --execute
ravi pages ship --project <projeto> --title "Docs" --route /docs --dir ./site --entrypoint index.html --json --execute
```

Regras:

- Sem slug posicional, o ship usa o host default do projeto: o site com `isDefault`, ou o slug `<orgSlug>-<projectSlug>`. Se esse host ainda não existe, o CLI cria só esse, com `isDefault`, e só quando `--execute` está presente. Não cria outro.
- `--title` é obrigatório e não gera host. Conteúdo: exatamente um de `--body` (fragmento, wrap HTML5), `--html` (arquivo) ou `--dir` (diretório + entrypoint).
- Defaults: `--visibility private`, `--route /` (home do projeto), `--entrypoint index.html`.
- Liste rotas com `ravi pages published` antes de publicar. `--route /` substitui a home. Outra página precisa de outra rota (`/relatorio`, `/docs`).
- `[project]` posicional junto com um segundo argumento é host legado. O projeto entra por `--project` ou pelo scope do Console.
- Depois de um ship com sucesso (`--execute`), o Ravi cria ou reusa um trigger `page-comment:<site id>` no tópico `ravi.watch.console.page.comment.created`. O trigger é por host, não por rota: todas as rotas do host default compartilham o mesmo, ligado ao primeiro agent que fez ship nesse host. Um segundo ship (mesmo de outro agent, em outra rota) não troca o agent; confira `commentFollow.agentId`. Comentário do próprio creator ainda acorda o agent. Sem agent no contexto, o ship segue e `commentFollow.skipped` fica `missing_creator`. O dry-run não arma o trigger.
- Não use `ship --execute` como sonda. Cada chamada cria um release real. Numa falha, leia `error.code` e `suggestedAction` e pare ou reporte; não repita com entradas variadas.

Prefixos reservados de host: `ravi` e `ravi-*`. O CLI não cria esses slugs. Não tente usá-los como host novo.

## Listar

```bash
ravi pages list --project <projeto> --json
ravi pages published --project <projeto> --json
```

`pages list` lista hosts do projeto. O host default tem `isDefault: true`. `pages published` lista rotas e URLs. Leia isso antes de escolher `--route`.

## Host legado

Não é o happy path. Um argumento posicional de slug cria ou reusa um host `*.ravi.page` extra e emite aviso. Não use isso para uma página nova. Sem `--execute` também é dry-run (exit 3).

```bash
ravi pages ship <slug-legado> --title "Página antiga" --route / --body "<h1>OK</h1>" --json --execute
```

`create` só cria o registro do host. `publish` sobe bytes num host já existente, ou publica um `art_*` que **já** está no ledger local. Os dois são dry-run até `--execute`. Prefira `ship` salvo o HTML já ser um `art_*`.

```bash
ravi pages create <slug> --json --execute
ravi pages publish <project-ref> <host> <artifact-id> --route / --json --execute
```

## Password / visibility / domain

O argumento ainda é o slug do host. A página é a rota.

```bash
ravi pages password set <host> --route /relatorio --execute
ravi pages password status <host> --route /relatorio --json
ravi pages password remove <host> --route /relatorio --visibility private --execute
ravi pages visibility <host> private
ravi pages visibility <host> public --execute
ravi pages visibility <host> public --route /relatorio --execute
ravi pages domains <host> docs.example.com --execute
```

`pages visibility` sem `--route` muda só o `defaultVisibility` do host. Rotas publicadas com visibility explícita (ex.: `/` private) continuam private. Use `--route /` (ou `/foo`) para mudar a política daquela rota sem reenviar arquivos. Sem `--execute`, o plano mostra host vs rota e current vs target (exit 3 para `public`). Com `--execute`, o JSON/humano reporta a visibility efetiva da rota alvo. Reduzir para `private` ou `protected_link` grava na hora, sem `--execute`.

`password set` sem `--execute` nem pede a senha. Automação: `--stdin` com input redirecionado. Nunca coloque a senha em argumento, env, log ou JSON.

## Backend auth / assertion audiences

A page que chama uma API sua não usa o JWT do `ravi login`. Esse token fica no CLI. Quem abre a page, depois que o Console já deixou ver a rota, pode receber uma asserção de curta duração. Essa asserção é cunhada para o viewer num host Pages específico. A page lê o bootstrap same-origin na hora. O HTML publicado não leva segredo.

`--aud` é para quem a asserção serve: o identificador da API. `--origin` é quais origens desse host Pages podem recebê-la — o host default (`https://<host>.ravi.page`) ou um hostname custom ativo no mesmo site. A URL da API não é `--origin`; o registro liga `(site, aud)` a esses hostnames. Colocar a URL da API em `--origin` falha na validação do Console com HTTP 400 `PAYLOAD_INVALID` (o hostname tem de ser o default deste site ou um hostname custom ativo).

Registre a audiência no host. `set` e `remove` sem `--execute` saem 3 com o plano. Nada é enviado. `list` só lê.

```bash
ravi pages assertion audiences list --site <host> --json
ravi pages assertion audiences set --site demo --aud https://api.exemplo --origin https://demo.ravi.page --execute
ravi pages assertion audiences set --site demo --aud https://api.exemplo --origin https://demo.ravi.page --origin https://docs.exemplo --execute
ravi pages assertion audiences remove --site <host> --aud <aud> --execute
```

`--site` é o `siteRef` do Console: slug do host, id do site, ou hostname (`acme-proj.ravi.page`). `--project` e `--console` seguem o grupo. `--origin` é `https` (esquema, host, porta opcional) e tem de ser uma origem deste site Pages, no mesmo host que `--site`. Pode repetir, inclusive um hostname custom já ativo nesse site (`https://docs.exemplo` no exemplo). `set` substitui a lista de origins daquele `aud`.

Para a page usar a asserção, o ship leva `uses` com `ravi.identity.assertion`:

```bash
ravi pages ship --project <projeto> --title "App" --route /app --dir ./site --uses ravi.identity.assertion --json --execute
```

`--uses` não grava token no artefacto. Sem esse id, o publish não declara a capability.

A API verifica a assinatura no JWKS do Console que respondeu. O JSON de `list`/`set`/`remove` traz `jwksUrl`. No Console padrão é `https://console.ravi.bot/api/public/pages/viewer-assertions/jwks`. Em outro Console, o mesmo path sai da base configurada.

Nunca grave o JWT da asserção, o access token ou o refresh token em log, argumento, env, HTML ou JSON de saída. O CLI descarta esses campos se o Console os devolver.
