# Ravi em sandbox E2B (PoC)

Roda uma task do Ravi numa microVM do E2B criada a partir de um snapshot. O fluxo é: clonar um repositório, delegar a task para um agente Claude, recolher o resultado e destruir a máquina.

## Como funciona

- **`template.ts`** constrói o template `ravi-runner`, com Ubuntu, Bun, nats-server e o Ravi clonado e já buildado. O start command sobe o `nats-server -js`. O E2B tira um snapshot de memória ao fim do build, então todo sandbox novo já nasce com o NATS escutando em `127.0.0.1:4222`.
- **`run-task.ts`** executa uma task:
  1. Cria o sandbox a partir do template.
  2. Clona o repositório em `/home/user/work/repo`.
  3. Sobe o `ravi daemon run` com as credenciais da task. O daemon fica fora do snapshot porque lê as credenciais do ambiente na partida; ele leva cerca de 4 s para ficar pronto.
  4. Cria o agente `worker` (provider `claude`, cwd = clone) com `full-access`.
  5. Cria o agente `operator` (haiku), que recebe os relatórios da task.
  6. Faz `ravi tasks create ... --agent worker` e acompanha até `done`, `failed` ou `blocked`.
  7. Salva `TASK.md`, `task.json`, `changes.patch` e `daemon.log` em `out/<sandbox-id>/`.
  8. Mata o sandbox, ou pausa se você passar `--keep`.

## Uso

```bash
cd pocs/e2b-sandbox
bun install

# 1. Uma vez só (e de novo quando quiser atualizar o Ravi do template)
E2B_API_KEY=e2b_... bun template.ts            # --ref <branch, default dev> --cpu 2 --memory 4096

# 2. Por task
E2B_API_KEY=e2b_... CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
  bun run-task.ts \
    --repo https://github.com/filipexyz/ravi.git \
    --title "Smoke" \
    --task "Leia o README e crie docs/SANDBOX_SMOKE.md com um resumo de 5 linhas. Depois finalize a task."
```

**Repositório privado:** passe `GITHUB_TOKEN`. O token é usado só no clone e não fica gravado no `.git/config`.

**Opções:**
- `--branch <b>`
- `--model <m>` (default `sonnet`)
- `--timeout-min <n>` (default 55, que cabe no limite de 1 h do plano Hobby)
- `--template <nome>`
- `--keep`

## Notas

- O Claude Code recusa `--dangerously-skip-permissions` como root. O sandbox do E2B roda como `user`, então funciona.
- O provider padrão do Ravi é `codex`, por isso os agentes são criados com `--provider claude`.
- `tasks create` fora de uma sessão Ravi exige `--report-to` apontando para uma sessão existente. É para isso que existe o `operator`.
- **Custo:** 2 vCPU / 4 GiB saem por cerca de $0,17/h de sandbox. Os tokens do modelo são cobrados à parte.
- **Próximo passo (arquitetura B):** deixar o daemon fora do sandbox e usar `src/remote-spawn-nats.ts` para rodar só o worker do Claude lá dentro.
- **Claude Code na web:** a sessão não enxerga `CLAUDE_CODE_OAUTH_TOKEN` nem `ANTHROPIC_API_KEY` definidas no ambiente. Use `RAVI_CLAUDE_CODE_OAUTH_TOKEN` (ou `RAVI_ANTHROPIC_API_KEY`); o `run-task.ts` repassa ao sandbox com o nome normal.
