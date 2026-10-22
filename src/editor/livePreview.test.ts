import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { build as buildPreview, setMarkMode, visibleGroup } from "./livePreview.ts";
import { build as buildRevisions, hiddenAcrossLines, setShowRevisions, showRevisions } from "./revisionsView.ts";

// Et tomt mærke får CodeMirror til at slå hele plugin'et fra resten af sessionen, så al formatering
// står som rå markdown (fejljagt 19/10). Markøren står i starten, så konstruktionerne ikke er »rørt«.
const view = (doc: string) => {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  return { state, visibleRanges: [{ from: 0, to: doc.length }] } as unknown as EditorView;
};

for (const doc of ["Før.\n\nSe [](https://x.dk) her.", "Før.\n\nSe []() her.", "Før.\n\nSe <u></u> her.", "Før.\n\nSe {>><<} her.", "Før.\n\nSe <!----> her."]) {
  test(`tomt led giver ingen tomme mærker: ${JSON.stringify(doc.slice(6))}`, () => {
    assert.doesNotThrow(() => buildPreview(view(doc)));
    assert.doesNotThrow(() => buildRevisions(view(doc)));
  });
}

// Ctrl+Backspace og Ctrl+Delete i »skjul« (fejljagt 19/10, F2-B2). `|` er markøren.
const fakeView = { dom: { classList: { toggle() {} } }, dispatch() {} } as unknown as EditorView;
const wordDelete = (text: string, forward: boolean) => {
  const head = text.indexOf("|");
  const doc = text.replace("|", "");
  setMarkMode(fakeView, "skjul");
  try {
    const v = view(doc);
    const atoms = buildPreview(v).update({ filter: (from, to, value) => value.point && to > from });
    const changes = v.state.changes(visibleGroup(v.state, atoms, head, forward));
    const at = changes.mapPos(head, -1);
    const out = changes.apply(v.state.doc).toString();
    return out.slice(0, at) + "|" + out.slice(at);
  } finally {
    setMarkMode(fakeView, "markoer");
  }
};

test("Ctrl+Backspace efter et link sletter linket, ikke kun adressen", () => {
  assert.equal(wordDelete("Se [her](https://x.dk)| nu", false), "Se | nu");
});
test("Ctrl+Backspace efter fed sletter ordet og stjernerne, når fed bliver tom", () => {
  assert.equal(wordDelete("Det er **fed**| her", false), "Det er | her");
});
test("Ctrl+Backspace i fed med flere ord tager kun det sidste ord", () => {
  assert.equal(wordDelete("Det er **meget fed**| her", false), "Det er **meget **| her");
});
test("Ctrl+Delete foran fed", () => {
  assert.equal(wordDelete("Det er |**fed** her", true), "Det er | her");
});
test("Ctrl+Backspace hen over fed midt i et ord", () => {
  assert.equal(wordDelete("Et fe**d**ord| her", false), "Et | her");
});
test("Ctrl+Backspace i almindelig tekst og ved linjestart", () => {
  assert.equal(wordDelete("Et ord|", false), "Et |");
  assert.equal(wordDelete("Et ord |", false), "Et |");
  assert.equal(wordDelete("Et\n|ord", false), "Et|ord");
});
test("Ctrl+Backspace efter en fodnote sletter fodnoten som ét tegn", () => {
  assert.equal(wordDelete("Ordet[^1]| og\n\n[^1]: n", false), "Ordet| og\n\n[^1]: n");
});

// Den rolige visning af rettelser (gæstens side, 20/10): kun den nye tekst og en streg i margenen.
test("rolig visning skjuler den gamle tekst og stregen står ud for linjerne", () => {
  const doc = "Først.\n\nEn {~~gammel\n\nlinje~>ny~~} og {++mere++}.\n\nSidst.";
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), showRevisions] }).update({ effects: setShowRevisions.of(false) }).state;
  const v = { state, visibleRanges: [{ from: 0, to: doc.length }] } as unknown as EditorView;
  const classes: string[] = [];
  const lines: number[] = [];
  const hidden: [number, number][] = [];
  buildRevisions(v).between(0, doc.length, (from, to, d) => {
    if (d.spec.class === "gt-rev-line") lines.push(state.doc.lineAt(from).number);
    else if (!d.spec.class && to > from) hidden.push([from, to]);
    else classes.push(d.spec.class);
  });
  const text = hidden.sort((a, b) => a[0] - b[0]).map(([a, b]) => doc.slice(a, b)).join("");
  // Et linjeskift må aldrig skjules af et plugin: CodeMirror slår det så fra. Den gamle tekst over
  // afsnitsskiftet skjules i ét stykke af StateField'et (hiddenAcrossLines), så der ikke står tomme linjer.
  assert.ok(!text.includes("\n"), text);
  assert.equal(text, "~~}{++++}");
  const across: string[] = [];
  hiddenAcrossLines(state).between(0, doc.length, (from, to) => void across.push(doc.slice(from, to)));
  assert.deepEqual(across, ["{~~gammel\n\nlinje~>"]);
  assert.deepEqual(lines.sort(), [3, 4, 5]);
  assert.ok(!classes.includes("gt-rev-new") && !classes.includes("gt-rev-old"), "ingen streger i teksten i den rolige visning");
});

test("{~~gammel~>ny~~} er ikke markdowns gennemstregning", async () => {
  const { criticSyntax } = await import("./criticSyntax.ts");
  const { syntaxTree } = await import("@codemirror/language");
  for (const doc of ["Vi {~~gik~>løb~~} hjem.", "Vi {~~gik~>~~} hjem.", "Det er ~~væk~~ nu."]) {
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [criticSyntax] })] });
    const names: string[] = [];
    syntaxTree(state).iterate({ enter: (n) => void names.push(n.name) });
    assert.equal(names.includes("Strikethrough"), doc.startsWith("Det"), `${doc}: ${names.join(" ")}`);
  }
});
