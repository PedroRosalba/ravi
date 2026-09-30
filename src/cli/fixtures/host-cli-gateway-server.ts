// Runs the real host CLI gateway in its own process, so tests that exercise a
// keyed `ravi` subprocess do not load the full command registry (and whatever
// module mocks other test files left behind) into the test process.
import "reflect-metadata";
import { startHostCliGateway } from "../host-cli-gateway.js";

const gateway = await startHostCliGateway();
if (!gateway) {
  console.error("host CLI gateway did not start");
  process.exit(1);
}
console.log(`ready ${gateway.socketPath}`);
const stop = async () => {
  await gateway.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
