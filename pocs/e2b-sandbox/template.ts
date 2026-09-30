/**
 * Builds the E2B template that every Ravi task sandbox starts from.
 *
 * The template holds a built Ravi checkout, Bun and nats-server. Its start
 * command launches nats-server with JetStream, so the memory snapshot E2B takes
 * at the end of the build already has NATS listening on 127.0.0.1:4222 when a
 * sandbox is created from it.
 *
 * The Ravi daemon is not part of the snapshot: it reads provider credentials
 * from its environment at startup, so run-task.ts starts it per sandbox with
 * that task's credentials.
 *
 *   E2B_API_KEY=... bun template.ts [--ref main] [--name ravi-runner]
 */

import { parseArgs } from "node:util";
import { Template, defaultBuildLogger, waitForPort } from "e2b";

const NATS_VERSION = "2.11.8";
const RAVI_REPO = "https://github.com/filipexyz/ravi.git";
const RAVI_DIR = "/home/user/ravi";

const { values } = parseArgs({
  options: {
    ref: { type: "string", default: "main" },
    name: { type: "string", default: "ravi-runner" },
    cpu: { type: "string", default: "2" },
    memory: { type: "string", default: "4096" },
  },
});

const natsTarball = `nats-server-v${NATS_VERSION}-linux-amd64`;

// Agent Bash tools call `ravi` by name, so it has to be on the default PATH.
// setEnvs() only applies during the build, hence wrappers in /usr/local/bin.
const raviWrapper = `#!/usr/bin/env bash
export RAVI_ALLOW_STALE_BUNDLE=1
exec ${RAVI_DIR}/bin/ravi "$@"
`;

const template = Template()
  .fromBaseImage()
  .aptInstall(["git", "curl", "unzip", "ca-certificates", "jq"])
  .runCmd(
    [
      `curl -fsSL https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/${natsTarball}.tar.gz | tar xz -C /tmp`,
      `mv /tmp/${natsTarball}/nats-server /usr/local/bin/nats-server`,
    ],
    { user: "root" },
  )
  .runCmd("curl -fsSL https://bun.sh/install | bash")
  .gitClone(RAVI_REPO, RAVI_DIR, { branch: values.ref, depth: 1 })
  .runCmd(`cd ${RAVI_DIR} && ~/.bun/bin/bun install --frozen-lockfile && ~/.bun/bin/bun run build`)
  .runCmd(
    [
      "ln -sf /home/user/.bun/bin/bun /usr/local/bin/bun",
      `printf '%s' '${raviWrapper}' > /usr/local/bin/ravi && chmod +x /usr/local/bin/ravi`,
    ],
    { user: "root" },
  )
  .runCmd("mkdir -p /home/user/.ravi/jetstream /home/user/work")
  .setStartCmd("nats-server -js -sd /home/user/.ravi/jetstream -a 127.0.0.1 -p 4222", waitForPort(4222));

const info = await Template.build(template, values.name, {
  cpuCount: Number(values.cpu),
  memoryMB: Number(values.memory),
  onBuildLogs: defaultBuildLogger(),
});

console.log(`\nTemplate ready: ${info.name} (id ${info.templateId})`);
