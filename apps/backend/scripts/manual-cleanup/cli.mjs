#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./common.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
if (!command || command === "help" || command === "--help") {
  console.log(
    "Dataset cleanup tool (Node >=22)\n\nscan     --network calibration|mainnet --payer ADDRESS --out DIRECTORY\nexecute  --input manifest.json [--network mainnet] [--include-abandoned] [--concurrency 8] [--limit N]\nverify   --input manifest.json [--state state.json]\nstatus   --state state.json\n\nexecute signs real transactions; scan/verify/status are read-only. Key: MANUAL_CLEANUP_PRIVATE_KEY. RPC: MANUAL_CLEANUP_RPC_URL. Execute automatically resumes transient failures and generates an acceptance report.",
  );
  process.exit(0);
}
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
let child,
  stop = false;
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    stop = true;
    child?.kill("SIGINT");
  });
function run(file, params) {
  return new Promise((resolve, reject) => {
    let errors = "";
    child = spawn(process.execPath, [path.join(dir, file), ...params], {
      stdio: ["inherit", "inherit", "pipe"],
      env: process.env,
    });
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
      errors = (errors + d.toString()).slice(-16000);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, errors }));
  });
}
if (command === "scan" || command === "verify") {
  const r = await run(`${command}.mjs`, args);
  process.exitCode = r.code;
} else if (command === "status") {
  if (!option("--state")) throw new Error("--state required");
  const s = JSON.parse(fs.readFileSync(option("--state"), "utf8"));
  const counts = {};
  for (const d of Object.values(s.datasets))
    counts[d.status ?? "unfinished"] = (counts[d.status ?? "unfinished"] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        chainId: s.chainId,
        payer: s.payer,
        signer: s.account,
        counts,
        pending: (s.pendingTransactions ?? (s.pending ? [s.pending] : [])).map(({ raw, ...tx }) => tx),
        summary: s.summary,
      },
      null,
      2,
    ),
  );
} else if (command === "execute") {
  const input = option("--input");
  if (!input) throw new Error("--input required");
  const manifest = loadManifest(input, option("--network"));
  const state = option("--state") ?? path.join(path.dirname(input), "state.json");
  const params = [...args, "--execute"];
  for (const [name, value] of [
    ["--limit", String(Math.max(1, manifest.candidates.length))],
    ["--concurrency", "8"],
    ["--delay-ms", "200"],
    ["--state", state],
  ])
    if (!option(name)) params.push(name, value);
  fs.mkdirSync(path.dirname(path.resolve(state)), { recursive: true });
  const lockPath = `${state}.supervisor.lock`;
  const lock = fs.openSync(lockPath, "wx", 0o600);
  fs.writeSync(lock, String(process.pid));
  const confirmed = () => {
    try {
      return Object.values(JSON.parse(fs.readFileSync(state, "utf8")).datasets).reduce(
        (n, d) => n + d.transactions.length,
        0,
      );
    } catch {
      return 0;
    }
  };
  let failures = 0;
  try {
    while (!stop) {
      const before = confirmed();
      const r = await run("cleanup.mjs", params);
      if (stop) {
        process.exitCode = 130;
        break;
      }
      if (r.code === 0) {
        const report = await run("verify.mjs", ["--input", input, "--state", state]);
        process.exitCode = report.code;
        break;
      }
      failures = confirmed() > before ? 0 : failures + 1;
      if (
        !/timeout|timed out|too long|HTTP|fetch|network|rate.limit|RPC|connection|socket/i.test(r.errors) ||
        failures >= 5
      ) {
        process.exitCode = r.code;
        break;
      }
      console.log("Transient RPC error: resuming saved transactions in 10 seconds");
      await new Promise((r) => setTimeout(r, 10000));
    }
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
} else throw new Error("Unknown command; use help");
