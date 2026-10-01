---
name: instances-manager
description: |
  Gerencia instâncias de canais do Ravi. Use quando o usuário quiser:
  - Criar, listar ou configurar instâncias (contas Omni ou WhatsApp nativo)
  - Conectar/desconectar contas WhatsApp, Matrix, etc
  - Conectar WhatsApp pelo transporte nativo (Baileys no runner `ravi channels`)
  - Migrar uma instância WhatsApp do Omni para o transporte nativo
  - Definir policies de DM e grupo por instância
  - Configurar contact intake automático por instância
  - Gerenciar rotas de uma instância específica
  - Aprovar ou rejeitar pendências de acesso
---

# Instances Manager

Instâncias são a entidade central de configuração do Ravi. Cada instância representa uma conta conectada (WhatsApp, Matrix, etc) com seu próprio agent, policies e rotas.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `INSTANCE_NOT_FOUND`, `ROUTE_NOT_FOUND`). O envelope traz `suggestions` com instâncias/rotas reais parecidas — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido). O envelope traz `acceptedFlags`: corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: `instances pending reject` é dry-run por default e exige `--execute`. As demais escritas gravam na hora, sem dry-run: `create`, `set`, `enable`, `disable`, `restore`, `delete`, `disconnect`, `connect` (interativo com QR — humano no loop), `routes add`, `routes set`, `routes remove`, `routes restore`, `pending approve`. Nessas o freio é você: confira o alvo antes de rodar.

Compact mode: `instances list` e `routes list` aceitam `--fields a,b,c` (ex.: `--fields name,channel,agent`) — use em varredura para não arrastar o objeto inteiro de cada instância/rota.

Help por operação: `ravi instances <op> --help` (idem nos grupos `routes` e `pending`) é enxuto; prefira-o ao help do domínio inteiro.

Checklist antes de responder sobre instâncias:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?

## Inspeção Cruzada

Instância isolada não conta a história toda. Ao diagnosticar o estado, combine instância com o que ela produz:

```bash
ravi instances list --json                    # canais conectados, intake mode, default tags
ravi instances show <name> --json             # detalhes + rotas + status ao vivo + transport (native|omni)
ravi contacts list --json                     # quantos contatos cada instância gerou
ravi chats list --json                        # quantos chats por instância
```

⚠️ **Instância sem `contactIntakeMode=discovered|pending`** = mensagens chegam mas não viram contato canônico. Cheque sempre.

⚠️ **Instância conectada mas sem agent** = mensagens caem na fila default ou em pending. Pode ser intencional (catch-all manual) ou esquecimento.

⚠️ **`defaultContactTags` vazia** + intake ligado = contatos criam sem etiqueta inicial. Sem etiqueta inicial, regras de classificação não têm gatilho.

## Comandos Principais

### Listar instâncias
```bash
ravi instances list
```

### Ver detalhes
```bash
ravi instances show <name>
```

### Criar instância
```bash
ravi instances create <name>
ravi instances create vendas --agent vendas-agent --channel whatsapp
```

### Configurar propriedades
```bash
ravi instances set <name> <key> <value>
```

Keys disponíveis:
- `agent` - Agent ID padrão desta instância
- `dmPolicy` - Política para DMs: `open` | `pairing` | `closed`
- `groupPolicy` - Política para grupos: `open` | `allowlist` | `closed`
- `dmScope` - Escopo de sessões DM: `main` | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
- `contactIntakeMode` - Criação/link automático de contatos em DMs: `off` | `discovered` | `pending`
- `instanceId` - UUID de transporte da instância (Omni ou nativo; auto-preenchido no connect, nunca troque numa migração)
- `channel` - Canal: `whatsapp` | `matrix` | etc

### Remover instância
```bash
ravi instances delete <name>            # soft-delete imediato, recuperável com restore
```

## Conexão de Canal

### Conectar WhatsApp
```bash
ravi instances connect <name>
ravi instances connect vendas --agent vendas-agent
ravi instances connect vendas --agent vendas-agent --transport native
```

`--transport <native|omni>` escolhe quem segura o socket do WhatsApp. Sem a flag, a ordem é:

1. canal não-WhatsApp (telegram, discord, ...) → omni;
2. instância que já tem canal WhatsApp nativo → native;
3. setting `whatsapp.transport` (`ravi settings set whatsapp.transport native`);
4. omni se o Omni estiver configurado, senão native.

`--transport native` com `--channel` não-WhatsApp é erro de uso (exit 2). `--transport omni` numa instância dona de canal nativo falha com `INSTANCE_NATIVE_OWNED`.

### Ver status
```bash
ravi instances status <name>
```

Com `--json`, `status`, `show`, `list` e `disconnect` trazem `transport` (`native`, `omni` ou `null`). Instância nativa consulta o runner: `live` traz `state` (`connected`, `connecting`, `qr`, `disconnected`, `logged_out`, `error`). Em `list`, runner fora do ar aparece como `disconnected` sem falhar; em `status`, falha com `WHATSAPP_RUNNER_UNAVAILABLE`.

### Desconectar
```bash
ravi instances disconnect <name>
```

Em instância nativa, `disconnect` fecha o socket no runner sem deslogar o aparelho: um `connect` depois reconecta sem QR.

## WhatsApp Nativo

O transporte nativo roda o Baileys dentro do runner `ravi channels` (processo PM2 `ravi-channels`), sem Omni. O daemon continua processando as mensagens pelo mesmo pipeline do Omni: sessões, chats, contatos e rotas não mudam.

Pré-requisitos:

- `ravi daemon start` rodando (ele repassa os QR codes para o CLI);
- `ravi channels start` rodando (o daemon não sobe o runner sozinho). Depois de atualizar o Ravi, use `ravi channels restart`.

O que `ravi instances connect <name> --transport native` faz:

1. cria a instância com UUID novo, ou mantém o UUID que ela já tem (ex.: vindo do Omni);
2. cria o canal `<name>` com provider `whatsapp` (`ravi channels show <name>`); o vínculo canal↔instância é pelo nome;
3. avisa o runner (`ravi.config.changed`) e espera até 15s ele subir o canal;
4. imprime QR codes até o celular conectar (até 120s); com `--json`, retorna no primeiro QR.

Erros comuns:

- `WHATSAPP_RUNNER_UNAVAILABLE`: o runner não respondeu. Rode `ravi channels start` (ou `ravi channels restart`) e repita o mesmo comando; instância e canal já ficaram criados.
- `INSTANCE_CONNECT_TIMEOUT`: nenhum QR/conexão chegou. Confira `ravi daemon status` e `ravi channels status`.
- `NATIVE_INSTANCE_CONFLICT`: o nome pertence a uma instância não-WhatsApp, a um canal de outro provider ou a um canal WhatsApp desabilitado.

Saúde: `ravi channels status` lista cada canal com estado e motivo (`connected`, `starting (pairing_required)`, `starting (qr_pending)`, `reconnecting`, `disconnected (logged_out|connection_replaced|...)`, `failed (missing_dependency)`). `pairing_required` ou `logged_out` → pareie de novo com `connect`. `connection_replaced` → outro processo usa a mesma sessão; procure um segundo runner.

### Migrar uma instância do Omni para o nativo

Uma instância por vez:

```bash
ravi instances show vendas --json                      # anote o instanceId (UUID): ele não muda
ravi channels status                                   # runner rodando? senão: ravi channels start
ravi instances disconnect vendas                       # ainda pelo Omni
# remova o aparelho do Omni no celular (WhatsApp > Aparelhos conectados)
ravi instances connect vendas --transport native       # escaneie o QR novo
ravi instances status vendas --json                    # transport "native", state "connected"
```

Depois teste uma DM e um grupo: devem cair nas mesmas sessões de antes.

Rollback:

```bash
ravi channels set vendas enabled false                 # a instância volta a ser do Omni na hora
ravi instances connect vendas --transport omni
```

Para voltar ao nativo: `ravi channels set vendas enabled true` e `ravi instances connect vendas --transport native` (reconecta sem QR se o aparelho não foi deslogado).

## Policies

Policies controlam quem pode iniciar conversa com o bot desta instância:

| Policy | Contexto | Comportamento |
|--------|----------|---------------|
| `dmPolicy=open` | DMs | Aceita qualquer DM |
| `dmPolicy=pairing` | DMs | Só aceita contatos previamente aprovados |
| `dmPolicy=closed` | DMs | Rejeita todos os DMs |
| `groupPolicy=open` | Grupos | Aceita qualquer grupo |
| `groupPolicy=allowlist` | Grupos | Só grupos com rota explícita (`ravi instances routes add`) |
| `groupPolicy=closed` | Grupos | Rejeita todos os grupos |

```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```

## Contact Intake

`contactIntakeMode` controla se DMs recebidas criam/linkam contatos canônicos automaticamente.

```bash
ravi instances show main --json
ravi instances set main contactIntakeMode discovered
```

Modos:
- `off`: não cria/linka contato automaticamente.
- `discovered`: cria/linka contato como descoberto, sem marcar como pendente operacional.
- `pending`: cria/linka contato como pendente.

Isso vale para mensagens novas. Para chats antigos já capturados, use:

```bash
ravi contacts backfill --instance main --mode discovered --dry-run --json
ravi contacts backfill --instance main --mode discovered --create-list crm-analysis-pending --apply --json
```

Contact intake não aprova rotas, não responde por si só e não grava análise CRM. Ele só garante identidade canônica, platform identity e vínculo com o ledger de chats.

## Rotas por Instância

```bash
ravi instances routes list <name>
ravi instances routes show <name> <pattern>
ravi instances routes add <name> <pattern> <agent>
ravi instances routes remove <name> <pattern>             # soft-delete imediato, recuperável com restore
ravi instances routes set <name> <pattern> <key> <value>
```

Padrões suportados:
- `5511*` - Prefixo de telefone
- `group:123456` - Grupo específico
- `thread:abc123` - Thread dentro de grupo (maior prioridade)
- `*` - Catch-all

## Pendências

Quando `dmPolicy=pairing` ou `groupPolicy=allowlist`, contatos/grupos desconhecidos ficam pendentes:

```bash
ravi instances pending list <name>
ravi instances pending approve <name> <id>    # aprova + cria rota
ravi instances pending reject <name> <id> --execute   # rejeita (sem --execute é dry-run, exit 3)
```

## Exemplos de Setup

### Bot público (responde tudo)
```bash
ravi instances create main --agent main --channel whatsapp
ravi instances set main dmPolicy open
ravi instances set main groupPolicy open
ravi instances connect main
```

### Bot sem Omni (WhatsApp nativo)
```bash
ravi channels start
ravi instances connect main --agent main --transport native
ravi instances set main dmPolicy open
```

### Bot controlado (só contatos aprovados)
```bash
ravi instances create suporte --agent suporte-agent
ravi instances set suporte dmPolicy pairing
ravi instances set suporte groupPolicy allowlist
ravi instances connect suporte
# Quando alguém envia mensagem → aparece em `pending list`
ravi instances pending list suporte
ravi instances pending approve suporte 5511999999999
```

### Multi-instância
```bash
ravi instances create vendas --agent vendas-agent
ravi instances create suporte --agent suporte-agent
ravi instances set vendas dmPolicy open
ravi instances set suporte dmPolicy pairing
ravi instances connect vendas
ravi instances connect suporte
```
