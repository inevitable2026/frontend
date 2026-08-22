// Compatibility entrypoint for the provisioning tool. It remains plan/read-only
// unless callers opt into --apply, smoke, or rollback explicitly.
import { runCli } from "./studio-provision.mjs";

runCli();
