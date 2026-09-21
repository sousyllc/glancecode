import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";

const codex = await import("../hub/codex.mjs");

test("codex items: messages, commands, edits and failures become glasses items", () => {
  const { codexItems } = codex;
  assert.deepEqual(codexItems({ id: "u1", type: "userMessage", content: [{ type: "text", text: "fix the tests" }, { type: "localImage", path: "/x.png" }] }), [
    { key: "u1", kind: "user", text: "fix the tests [image]", ts: undefined },
  ]);
  assert.equal(codexItems({ id: "a1", type: "agentMessage", text: "  Done.  " })[0].text, "Done.");
  assert.deepEqual(codexItems({ id: "r1", type: "reasoning", summary: ["x"], content: [] }), []);

  const shell = codexItems({ id: "c1", type: "commandExecution", command: `/bin/zsh -lc "printf '%s\\\\n' hi > a.txt"`, commandActions: [{ type: "unknown" }], status: "completed", exitCode: 0 });
  assert.deepEqual(shell, [{ key: "c1", kind: "tool", tool: "Shell", text: "printf '%s\\n' hi > a.txt", ts: undefined }]);

  const read = codexItems({ id: "c2", type: "commandExecution", command: "cat src/app.ts", commandActions: [{ type: "read", command: "cat", name: "app.ts", path: "/p/src/app.ts" }], status: "completed", exitCode: 0 });
  assert.equal(`${read[0].tool} ${read[0].text}`, "Read app.ts");

  const failed = codexItems({ id: "c3", type: "commandExecution", command: "npm test", commandActions: [], status: "failed", exitCode: 1, aggregatedOutput: "\n  1 test failed\nmore" });
  assert.equal(failed[1].kind, "error");
  assert.equal(failed[1].text, "exit 1: 1 test failed");

  const edit = codexItems({ id: "f1", type: "fileChange", status: "completed", changes: [{ path: "/p/a.ts", kind: { type: "update" } }, { path: "/p/b.ts", kind: { type: "update" } }, { path: "/p/c.ts", kind: { type: "update" } }] });
  assert.equal(`${edit[0].tool} ${edit[0].text}`, "Edit a.ts, b.ts +1");
  const add = codexItems({ id: "f2", type: "fileChange", status: "declined", changes: [{ path: "/p/new.md", kind: { type: "add" } }] });
  assert.equal(add[0].tool, "Write");
  assert.equal(add[1].text, "Edit declined");
});

test("codex turns note interruptions and failures", () => {
  const items = codex.turnItems({ id: "t1", status: "interrupted", startedAt: 1789619153, items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "go" }] }] });
  assert.deepEqual(
    items.map((i) => [i.kind, i.text]),
    [
      ["user", "go"],
      ["notice", "Interrupted"],
    ],
  );
  assert.equal(codex.turnItems({ id: "t2", status: "failed", error: { message: "usage limit reached" }, items: [] })[0].text, "usage limit reached");
});

test("codex approvals map to options and back to decisions", () => {
  const { waitingFromRequest, approvalResult } = codex;
  const cmd = waitingFromRequest("item/commandExecution/requestApproval", { command: "/bin/zsh -lc 'rm -rf build'", reason: "clean the build" });
  assert.deepEqual(cmd, { kind: "permission", tool: "Shell", detail: "rm -rf build", options: ["Yes", "Yes, for this session", "No"], reason: "clean the build" });
  assert.deepEqual(approvalResult("item/commandExecution/requestApproval", {}, 0), { decision: "accept" });
  assert.deepEqual(approvalResult("item/fileChange/requestApproval", {}, 1), { decision: "acceptForSession" });
  assert.deepEqual(approvalResult("item/fileChange/requestApproval", {}, 2), { decision: "decline" });

  const edit = waitingFromRequest("item/fileChange/requestApproval", { reason: null }, { type: "fileChange", changes: [{ path: "/p/README.md", kind: { type: "update" } }] });
  assert.equal(`${edit.tool} ${edit.detail}`, "Edit README.md");

  const perms = { network: { enabled: true }, fileSystem: null };
  assert.deepEqual(approvalResult("item/permissions/requestApproval", { permissions: perms }, 1), { permissions: { network: { enabled: true } }, scope: "session" });
  assert.deepEqual(approvalResult("item/permissions/requestApproval", { permissions: perms }, 2), { permissions: {}, scope: "turn" });

  assert.equal(waitingFromRequest("mcpServer/elicitation/request", {}), null); // left to the terminal
});

test("codex questions are answered one at a time and sent together", async () => {
  const sent = [];
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), changed() {} });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ready = true;
  bridge.respond = (id, result) => sent.push({ id, result });
  const s = { id: "th", agent: "codex", state: "working", codexJoined: true, lastActivity: 0 };
  registry.sessions.set("th", s);

  bridge.onServerRequest(7, "item/tool/requestUserInput", {
    threadId: "th",
    questions: [
      { id: "q1", header: "Plan", question: "Which approach?", isOther: false, isSecret: false, options: [{ label: "Small", description: "" }, { label: "Big", description: "" }] },
      { id: "q2", header: "Name", question: "What should it be called?", isOther: true, isSecret: false, options: null },
    ],
  });
  assert.equal(s.state, "waiting");
  assert.deepEqual(bridge.dialog(s), { kind: "question", options: ["Small", "Big"] });

  assert.equal(await bridge.choose(s, "question", 1), "Big");
  assert.equal(sent.length, 0); // one question still open
  assert.equal(s.waiting.detail, "What should it be called?");
  await bridge.answer(s, "glasses mode");
  assert.deepEqual(sent, [{ id: 7, result: { answers: { q1: { answers: ["Big"] }, q2: { answers: ["glasses mode"] } } } }]);
  assert.equal(s.waiting, null);
  assert.equal(s.state, "working");
});

test("an approval answered elsewhere clears the glasses", () => {
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), changed() {} });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  const s = { id: "th", agent: "codex", state: "working", codexJoined: true };
  registry.sessions.set("th", s);
  let attention = 0;
  registry.on("attention", () => attention++);
  bridge.onServerRequest(3, "item/commandExecution/requestApproval", { threadId: "th", command: "ls" });
  assert.equal(s.state, "waiting");
  assert.equal(attention, 1);
  bridge.onNotification("serverRequest/resolved", { threadId: "th", requestId: 3 });
  assert.equal(s.waiting, null);
  assert.equal(s.state, "working");
});

test("a session another Codex server owns explains why it can't be opened", async () => {
  const registry = Object.assign(new EventEmitter(), { sessions: new Map(), changed() {} });
  const bridge = new codex.CodexBridge({ registry, bin: "codex", socket: "/tmp/none.sock" });
  bridge.ready = true;
  bridge.call = async () => {
    throw new Error("no rollout found for thread id abc");
  };
  await assert.rejects(() => bridge.resumeSession({ id: "abc" }), /standalone build.*no rollout found/s);
  bridge.shared = true;
  await assert.rejects(() => bridge.resumeSession({ id: "abc" }), /Codex Cloud or another computer/);
});

test("helper threads are hidden and remote arguments carry the folder", () => {
  assert.equal(codex.isHelperThread({ ephemeral: true }), true);
  assert.equal(codex.isHelperThread({ ephemeral: false, source: { subAgent: {} } }), true);
  assert.equal(codex.isHelperThread({ ephemeral: false, source: "cli", parentThreadId: null }), false);

  const sock = "/home/me/.config/glancecode/codex.sock";
  assert.deepEqual(codex.remoteArgs(sock, ["-m", "gpt-5.5"], "/p"), ["--remote", `unix://${sock}`, "-C", "/p", "-m", "gpt-5.5"]);
  assert.deepEqual(codex.remoteArgs(sock, ["resume", "abc"], "/p"), ["resume", "--remote", `unix://${sock}`, "-C", "/p", "abc"]);
  assert.deepEqual(codex.remoteArgs(sock, ["-C", "/other"], "/p"), ["--remote", `unix://${sock}`, "-C", "/other"]);
});

test("websocket client: handshake, masked sends, long and fragmented messages", async () => {
  const { WsClient } = await import("../hub/wsclient.mjs");
  const received = [];
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {}); // the client hangs up at the end of the test
    socket.once("data", (buf) => {
      // Answer the first message only; the next frame is the client's close.
      // Decode one masked client frame (the test only sends small ones).
      const len = buf[1] & 0x7f;
      const mask = buf.subarray(2, 6);
      received.push(Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString());
      const big = "x".repeat(70_000);
      const long = Buffer.alloc(10);
      long[0] = 0x81;
      long[1] = 127;
      long.writeBigUInt64BE(BigInt(big.length), 2);
      socket.write(Buffer.concat([long, Buffer.from(big)]));
      // "he" + "llo" as a text frame and a continuation frame, split across writes.
      socket.write(Buffer.from([0x01, 2, ...Buffer.from("he")]));
      socket.write(Buffer.from([0x80, 3]));
      socket.write(Buffer.from("llo"));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ws = new WsClient(`ws://127.0.0.1:${server.address().port}`);
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => ws.send('{"hi":1}'));
    ws.on("message", (m) => {
      messages.push(m);
      if (messages.length === 2) resolve();
    });
  });
  ws.close();
  server.close();
  assert.deepEqual(received, ['{"hi":1}']);
  assert.equal(messages[0].length, 70_000);
  assert.equal(messages[1], "hello");
});
