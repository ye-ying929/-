import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

const ownerRepo = process.env.GITHUB_REPOSITORY;
const [owner, repo] = (ownerRepo || "").split("/");
const prNumber = Number(process.env.PR_NUMBER);
const crossRunId = Number(process.env.CROSS_RUN_RUN_ID);
const crossJobId = Number(process.env.CROSS_RUN_JOB_ID);
const expectedMarker = process.env.EXPECTED_MARKER || "";
const token = process.env.GITHUB_TOKEN;

for (const [name, value] of Object.entries({
  GITHUB_REPOSITORY: ownerRepo,
  PR_NUMBER: process.env.PR_NUMBER,
  GITHUB_TOKEN: token ? "present" : "",
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (!owner || !repo || !Number.isInteger(prNumber)) {
  throw new Error("GITHUB_REPOSITORY and PR_NUMBER must be valid");
}
if (!Number.isInteger(crossRunId) || !Number.isInteger(crossJobId)) {
  throw new Error("cross-run IDs must be integers");
}

const server = spawn("bun", ["src/mcp/github-actions-server.ts"], {
  cwd: "action-src",
  env: {
    ...process.env,
    REPO_OWNER: owner,
    REPO_NAME: repo,
    PR_NUMBER: String(prNumber),
    GITHUB_TOKEN: token,
    RUNNER_TEMP: process.env.RUNNER_TEMP,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  stdout += chunk;
});
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`timed out waiting for MCP response ${id}`));
    }, 45_000);

    const onData = () => {
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== id) continue;
        clearTimeout(deadline);
        server.stdout.off("data", onData);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
    };
    server.stdout.on("data", onData);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function resultText(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result has no text");
  return text;
}

try {
  const initialized = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "live-ci-binding-audit", version: "1.0.0" },
  });
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const status = JSON.parse(
    resultText(
      await call("tools/call", {
        name: "get_ci_status",
        arguments: {},
      }),
    ),
  );
  const details = JSON.parse(
    resultText(
      await call("tools/call", {
        name: "get_workflow_run_details",
        arguments: { run_id: crossRunId },
      }),
    ),
  );
  const downloaded = JSON.parse(
    resultText(
      await call("tools/call", {
        name: "download_job_log",
        arguments: { job_id: crossJobId },
      }),
    ),
  );
  const logBody = await readFile(downloaded.path, "utf8");
  const detailsContainsJob = details.jobs?.some((job) => job.id === crossJobId) === true;
  const markerSeen = logBody.includes(expectedMarker);
  const currentRunIds = (status.runs || []).map((run) => run.id);
  const summary = {
    status: "confirmed_live_workflow_token",
    repository: ownerRepo,
    pr_number: prNumber,
    current_pr_head_run_ids: currentRunIds,
    requested_run_id: crossRunId,
    requested_job_id: crossJobId,
    details_tool_returned_requested_job: detailsContainsJob,
    requested_run_is_current_pr_head_run: currentRunIds.includes(crossRunId),
    downloaded_size_bytes: downloaded.size_bytes,
    expected_synthetic_marker_seen: markerSeen,
    server_initialized: Boolean(initialized?.serverInfo?.name),
    no_secret_or_write_operation: true,
  };
  console.log(JSON.stringify(summary));
  if (!detailsContainsJob || currentRunIds.includes(crossRunId) || !markerSeen) {
    throw new Error(`binding proof did not meet expected conditions: ${JSON.stringify(summary)}`);
  }
} finally {
  server.stdin.end();
  const exitPromise = once(server, "exit");
  const timer = setTimeout(() => server.kill(), 5000);
  await exitPromise.catch(() => {});
  clearTimeout(timer);
  if (stderr.includes("Authorization: Bearer")) {
    throw new Error("unexpected credential text in MCP stderr");
  }
}
