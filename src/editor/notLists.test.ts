import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { dateEscapeAt, isReplik, leaveListAfterEnter, replikDashes } from "./notLists.ts";
import { markdownIt, prepare } from "../print/render.ts";

test("en dato i linjestart findes, andet gør ikke", () => {
  assert.equal(dateEscapeAt("4. maj kom befrielsen."), 1);
  assert.equal(dateEscapeAt("24. december"), 2);
  assert.equal(dateEscapeAt("> 1. januar"), 3);
  assert.equal(dateEscapeAt("4. majestæten"), null);
  assert.equal(dateEscapeAt("4. Maj"), null);
  assert.equal(dateEscapeAt("4. punkt"), null);
  assert.equal(dateEscapeAt("4\\. maj"), null);
});

test("replikker med bindestreg kendes på »sagde« eller replikken før", () => {
  assert.ok(isReplik("- Hej, sagde hun.", undefined));
  assert.ok(isReplik("- Kommer du? spurgte han.", undefined));
  assert.ok(isReplik("- Ja.", "– Hej, sagde hun."));
  assert.ok(!isReplik("- Køb mælk.", undefined));
  assert.ok(!isReplik("- Ja.", "- Køb mælk."));
  assert.ok(!isReplik("- hej, sagde hun.", undefined));
  assert.equal(replikDashes("- Hej, sagde hun.\n\n- Hej selv.\n\nHun gik.\n\n- Køb mælk"), "– Hej, sagde hun.\n\n– Hej selv.\n\nHun gik.\n\n- Køb mælk");
});

// Enter, som i editoren: listen fortsættes, og bagefter holdes datoen eller replikken ude af den.
const enter = (doc: string) => {
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: markdown({ base: markdownLanguage }) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: Parameters<EditorView["dispatch"]>[0]) => {
      state = state.update(spec as never).state;
    },
  } as unknown as EditorView;
  const before = state;
  assert.ok(insertNewlineContinueMarkupCommand({ nonTightLists: false })(view));
  leaveListAfterEnter(view, before);
  return state.doc.toString();
};

test("Enter efter »4. maj« giver et nyt afsnit, ikke »5. «", () => {
  assert.equal(enter("4. maj kom befrielsen."), "4\\. maj kom befrielsen.\n");
  assert.equal(enter("Før.\n\n- Hej, sagde hun."), "Før.\n\n– Hej, sagde hun.\n");
  // En rigtig liste fortsætter som før.
  assert.equal(enter("4. punkt"), "4. punkt\n5. ");
  assert.equal(enter("- Køb mælk."), "- Køb mælk.\n- ");
});

test("eksport: datoen og replikken bliver brødtekst", () => {
  for (const doc of ["4. maj kom befrielsen.", "4\\. maj kom befrielsen.", "- Hej, sagde hun."]) {
    const html = markdownIt().render(prepare(doc, false));
    assert.ok(!/<[ou]l/.test(html), html);
  }
  assert.ok(markdownIt().render(prepare("4\\. maj kom", false)).includes("4. maj"));
});
