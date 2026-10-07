import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

import { TextMemo } from "./touches.ts";
import { findDimmed } from "./inline.ts";
import { findNotes, findRevisions } from "./critic.ts";

const DOC = [
  "# Overskrift",
  "",
  "Første afsnit med {--dæmpet tekst--} og en note{>> husk kilden <<} midt i.",
  "",
  "Andet afsnit med {++ny tekst++} og {~~gammel~>ny~~} rettelse.",
  "",
  "{--Dæmpet over",
  "",
  "to afsnit--} og så videre i teksten.",
  "",
  "Sidste afsnit uden mærker overhovedet, bare almindelig tekst.",
].join("\n");

// Et ViewUpdate med det, TextMemo bruger.
const fakeUpdate = (state: EditorState, tr: ReturnType<EditorState["update"]>) =>
  ({ docChanged: tr.docChanged, startState: state, state: tr.state, transactions: [tr], changes: tr.changes }) as unknown as ViewUpdate;

test("flyttede fund er de samme som fund forfra, også efter 500 tilfældige tastetryk", () => {
  const dimmed = new TextMemo(
    ["{--", "--}"],
    (d) => findDimmed(d),
    (found, ch) =>
      found.map((d) => ({
        open: { from: ch.mapPos(d.open.from, 1), to: ch.mapPos(d.open.to, -1) },
        body: { from: ch.mapPos(d.body.from, 1), to: ch.mapPos(d.body.to, 1) },
        close: { from: ch.mapPos(d.close.from, 1), to: ch.mapPos(d.close.to, -1) },
      })),
    (found) => found.map((d) => ({ from: d.open.from, to: d.close.to })),
  );
  const critic = new TextMemo(
    ["{>>", "<<}", "{++", "++}", "{~~", "~>", "~~}"],
    (s) => ({ notes: findNotes(s), revisions: findRevisions(s) }),
    (f, ch) => ({
      notes: f.notes.map((n) => ({ ...n, from: ch.mapPos(n.from), to: ch.mapPos(n.to) })),
      revisions: f.revisions.map((r) => ({ ...r, from: ch.mapPos(r.from), to: ch.mapPos(r.to), oldFrom: ch.mapPos(r.oldFrom), nextFrom: ch.mapPos(r.nextFrom) })),
    }),
    (f) => [...f.notes, ...f.revisions],
  );
  let state = EditorState.create({ doc: DOC });
  dimmed.get(state.doc);
  critic.get(state.doc);
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let i = 0; i < 500; i++) {
    const pos = rnd(state.doc.length + 1);
    const del = rnd(4) === 0 && pos < state.doc.length;
    const insert = ["e", " ", "\n", "-", "{", "}", "~", ">"][rnd(8)];
    const tr = state.update(del ? { changes: { from: pos, to: pos + 1 } } : { changes: { from: pos, insert } });
    const u = fakeUpdate(state, tr);
    dimmed.advance(u);
    critic.advance(u);
    state = tr.state;
    const text = state.doc.toString();
    const d = dimmed.get(state.doc);
    assert.deepEqual(
      d.map((x) => [x.open.from, x.close.to]),
      findDimmed(text).map((x) => [x.open.from, x.close.to]),
      `dæmpet efter tastetryk ${i}`,
    );
    const c = critic.get(state.doc);
    assert.deepEqual(c.notes, findNotes(text), `noter efter tastetryk ${i}`);
    assert.deepEqual(c.revisions, findRevisions(text), `rettelser efter tastetryk ${i}`);
  }
});
