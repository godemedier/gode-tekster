import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { DocumentDto, SessionIO } from "./document.ts";

Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 0, clearTimeout: () => {}, dispatchEvent: () => true, addEventListener: () => {} } });
const { DocumentSession } = await import("./document.ts");

const dto: DocumentDto = { path: "test.md", name: "test.md", text: "start", authors: [], me: { kind: "human", name: "", identifier: null }, staleBlocks: [], mixedEol: false, cursor: null, hasBlock: false, external: [] };
function fixture(handler: (command: string, args: Record<string, unknown>) => unknown | Promise<unknown>) {
  const view = {
    state: EditorState.create({ doc: dto.text }),
    dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state; },
  };
  const messages: string[] = [];
  const io: SessionIO = {
    invoke: <T>(command: string, args?: unknown) => Promise.resolve().then(() => handler(command, (args ?? {}) as Record<string, unknown>)) as Promise<T>,
    showBanner: (message) => { messages.push(message); return messages.length; }, hideBanner: () => {}, notify: () => {},
  };
  const session = new DocumentSession(view as unknown as EditorView, { ...dto }, () => {}, io);
  const type = (text: string) => { view.dispatch({ changes: { from: view.state.doc.length, insert: text } }); session.changed(); };
  return { session, view, messages, type };
}

test("lukning nægtes, når både gem og nødkopi fejler", async () => {
  const calls: string[] = [];
  const f = fixture((command) => {
    calls.push(command);
    if (command === "save_document") throw { kind: "io", message: "låst" };
    if (command === "backup_text") throw new Error("fuldt drev");
  });
  f.type(" nyere tekst");
  await assert.rejects(f.session.close(), /fuldt drev/);
  assert.ok(!calls.includes("release_document"));
  assert.equal(f.view.state.doc.toString(), "start nyere tekst");
  await assert.rejects(f.session.saveForHandoff(), /kunne ikke gemmes/);
});

test("versionsvisning nægtes, hvis aktuelle rettelser ikke kan gemmes", async () => {
  const f = fixture((command) => {
    if (command === "save_document") throw { kind: "mixed-eol", message: "blandet" };
  });
  f.type(" ugemt");
  await assert.rejects(f.session.pause(true), /kunne ikke gemmes/);
  assert.equal(f.view.state.doc.toString(), "start ugemt");
});

test("lukning bevarer den nyeste tekst, også når der skrives under nødkopieringen", async () => {
  const copies: string[] = [];
  const f = fixture((command, args) => {
    if (command === "save_document") throw { kind: "mixed-eol", message: "blandet" };
    if (command === "backup_text") {
      copies.push(String(args.text));
      if (copies.length === 1) f.type(" sidste ord");
    }
  });
  f.type(" ændret");
  await f.session.close();
  assert.equal(copies.at(-1), "start ændret sidste ord");
});

test("fletning bruger nye positioner efter hvert tastetryk under IPC", async () => {
  let merges = 0;
  const f = fixture((command, args) => {
    if (command === "open_document") return { ...dto, text: "start ekstern" };
    if (command === "merge_texts") {
      const mine = String(args.mine);
      if (merges++ < 2) f.type(String(merges));
      return { conflict: false, changes: [{ from: mine.length, insert: " ekstern" }] };
    }
  });
  f.type(" lokal");
  await f.session.externalChange();
  assert.equal(merges, 3);
  assert.equal(f.view.state.doc.toString(), "start lokal12 ekstern");
});

test("lukning venter på en langsom fletning før editoren kan bruges til næste fil", async () => {
  let loaded!: (value: unknown) => void;
  const fresh = new Promise((resolve) => { loaded = resolve; });
  const f = fixture((command, args) => {
    if (command === "open_document") return fresh;
    if (command === "merge_texts") return { conflict: false, changes: [{ from: String(args.mine).length, insert: " ekstern" }] };
  });
  f.type(" lokal");
  const merge = f.session.externalChange();
  let closed = false;
  const closing = f.session.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  loaded({ ...dto, text: "start ekstern" });
  await Promise.all([merge, closing]);
  assert.equal(f.view.state.doc.toString(), "start lokal ekstern");
  await f.session.externalChange();
  assert.equal(f.view.state.doc.toString(), "start lokal ekstern");
});

test("mislykket afslutning af et andet vindue stopper ikke autosave i det første", async () => {
  let saves = 0;
  const f = fixture((command) => { if (command === "save_document") saves++; });
  f.type(" først");
  await f.session.prepareExit();
  f.type(" siden");
  await f.session.flush();
  assert.equal(saves, 2);
});
