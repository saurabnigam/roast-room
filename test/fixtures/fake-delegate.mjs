// A stand-in for delegate.py, for run_seat tests only. It never calls a model.
//
// Tests run it as `<node> fake-delegate.mjs run codex --isolated --json --task-file F ...`.
//   FAKE_DELEGATE_LOG     file. One JSON line is appended per call:
//                         { argv, taskFile, task, mode, pid, secretEnvNames, keptEnvNames }
//                         (the task file is read while it exists). The env fields hold NAMES only, never values:
//                         secretEnvNames = the sorted names in the environment that look like a key, token,
//                         secret, password or credential; keptEnvNames = which of PATH, HOME, CODEX_HOME,
//                         DELEGATE_PY and DELEGATE_PYTHON are present.
//   FAKE_DELEGATE_EXIT    exit code, default 0. A comma list ("3,0") gives the code for call 1, 2, ...
//                         and repeats the last one. A call is counted from the lines already in the log.
//                         Two words stand in for a code: "sleep" never answers (it gives up after 60 s, so a
//                         failed kill cannot leave it behind for long), and "orphan" prints a good reply and
//                         exits 0 while a grandchild keeps stdout and stderr open for 3 s.
//   FAKE_DELEGATE_STDOUT  with exit 0, print this text instead of the JSON reply.
// Exit 0 prints one JSON object with "reply", like delegate.py --json. Exit 2 is a refusal with
// its reason on stderr. Any other code prints a failure object with "reply": null.
import fs from "node:fs";
import { spawn } from "node:child_process";

const CARD = [
  "SEAT: BUFFETT",
  "STANCE: Yes",
  "OPTION SCORES: A 8 · B 4",
  "THE CALL: Do A first.",
  "CONFIDENCE: 4",
  "RUIN RISK: none",
  "DOOR: two-way",
].join("\n");

const argv = process.argv.slice(2);
const log = process.env.FAKE_DELEGATE_LOG;
const calls = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;

const at = argv.indexOf("--task-file");
const taskFile = at >= 0 ? argv[at + 1] : null;
let task = null;
let mode = null;
try {
  task = fs.readFileSync(taskFile, "utf8");
  mode = fs.statSync(taskFile).mode & 0o777;
} catch { /* no task file: the log says so */ }
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;
const secretEnvNames = Object.keys(process.env).filter((n) => SECRET_NAME.test(n)).sort();
const keptEnvNames = ["PATH", "HOME", "CODEX_HOME", "DELEGATE_PY", "DELEGATE_PYTHON"].filter((n) => n in process.env);
if (log) fs.appendFileSync(log, JSON.stringify({ argv, taskFile, task, mode, pid: process.pid, secretEnvNames, keptEnvNames }) + "\n");

const plan = String(process.env.FAKE_DELEGATE_EXIT ?? "0").split(",").map((s) => s.trim());
const word = plan[Math.min(calls, plan.length - 1)];
const reply = () =>
  process.env.FAKE_DELEGATE_STDOUT ??
  JSON.stringify({ status: "ok", provider: argv[1], input_tokens: 1200, cached_input_tokens: 0, output_tokens: 300, reply: CARD }, null, 2) + "\n";

if (word === "sleep") {
  setTimeout(() => process.exit(0), 60000);
  await new Promise(() => {}); // hold the process open until it is killed
}
if (word === "orphan") {
  // A grandchild that inherits stdout and stderr and outlives this process, like a CLI left behind.
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
  process.stdout.write(reply());
} else {
  const code = Number(word);
  if (code === 0) {
    process.stdout.write(reply());
  } else if (code === 2) {
    process.stderr.write("delegate: refused, 1 possible secret(s) found; nothing was sent\n");
  } else {
    process.stdout.write(JSON.stringify({ status: "timeout", error: "no answer within 570s", reply: null }, null, 2) + "\n");
  }
  process.exitCode = code;
}
