import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grammarFlags } from "./grammar.ts";

const lex = JSON.parse(readFileSync(new URL("../assets/ordklasser.json", import.meta.url), "utf8")) as { v: string[] };
const verbs = new Set(lex.v);
const fix = (t: string) => grammarFlags(t, verbs).map((f) => `${t.slice(f.from, f.to)}→${f.replacement}`);

test("navnemåde efter »at« og mådesudsagnsord", () => {
  assert.deepEqual(fix("Det er svært at giver slip."), ["giver→give"]);
  assert.deepEqual(fix("Hun vil spørger chefen."), ["spørger→spørge"]);
  assert.deepEqual(fix("Det kan er rigtigt."), ["er→være"]);
  assert.deepEqual(fix("Vi skal har det klar."), ["har→have"]);
  assert.deepEqual(fix("Det er svært at give slip."), []);
});

test("nutid efter jeg, du, han, hun, vi og man", () => {
  assert.deepEqual(fix("Vi lære meget af det."), ["lære→lærer"]);
  assert.deepEqual(fix("Hun tro, at det går."), ["tro→tror"]);
  assert.deepEqual(fix("Jeg være glad."), ["være→er"]);
  assert.deepEqual(fix("Vi lærer meget."), []);
});

test("nutid: står sætningen i datid, foreslås datid (målebænken 12/10)", () => {
  assert.deepEqual(fix("Modellen kom til mig, efter jeg have været inde i data."), ["have→havde"]);
  assert.deepEqual(fix("Det gik godt, fordi jeg være forberedt."), ["være→var"]);
  // Datid i en anden sætning tæller ikke, og »så« er biord.
  assert.deepEqual(fix("Han kom. Nu jeg have tid."), ["have→har"]);
  assert.deepEqual(fix("Og så jeg have tid."), ["have→har"]);
  // Kendes datid ikke, foreslås nutid stadig, men beskeden nævner datid.
  const [f] = grammarFlags("Det var sjovt, men vi lære meget.", verbs);
  assert.equal(f.replacement, "lærer");
  assert.match(f.message, /datid/);
});

test("omvendt ordstilling er rigtig og markeres ikke", () => {
  assert.deepEqual(fix("Kan vi lære det?"), []);
  assert.deepEqual(fix("I morgen skal jeg skrive."), []);
  assert.deepEqual(fix("Det er godt at du ser det."), []);
});

test("dobbelte småord, men ikke over et punktum eller en linje", () => {
  assert.deepEqual(fix("Han kom og og gik."), ["og→"]);
  assert.deepEqual(fix("Han kom med med bilen."), ["med→"]);
  assert.deepEqual(fix("Det er det, du mener."), []);
  assert.deepEqual(fix("Han gik ud og.\nOg så kom han."), []);
});

test("stort begyndelsesbogstav følger med, og citater markeres ikke", () => {
  assert.deepEqual(fix("At giver op er svært."), ["giver→give"]);
  assert.deepEqual(fix("Han sagde: »vi lære af det«."), []);
});

test("falske fund fundet i et korpus af fagbladsartikler (7/10) markeres ikke", () => {
  assert.deepEqual(fix("Povl Gad er cand.mag."), []);
  assert.deepEqual(fix("men kunne ved hjemkomsten se det"), []);
  assert.deepEqual(fix("så lod han være."), []);
  assert.deepEqual(fix("som jeg få dage inden havde mødt"), []);
  assert.deepEqual(fix("Underforstået at søger man hjælp, får man den."), []);
  assert.deepEqual(fix("Der bliver lagt vægt på, at lærer og pædagog arbejder sammen."), []);
  assert.deepEqual(fix("bruge mit liv på på kort sigt"), []);
  assert.deepEqual(fix("Nu bliver ph.d.en en reel karrierevej."), []);
  assert.deepEqual(fix("skulle min mand og jeg melde fra"), []);
  assert.deepEqual(fix("luskede jeg stille hjem"), []);
});

const agree = JSON.parse(readFileSync(new URL("../assets/kongruens.json", import.meta.url), "utf8")) as Parameters<typeof grammarFlags>[2];
const lexK = JSON.parse(readFileSync(new URL("../assets/ordklasser.json", import.meta.url), "utf8")) as { a: string[]; n: string[] };
const adjs = new Set(lexK.a);
const nouns = new Set(lexK.n);
const fixK = (t: string) => grammarFlags(t, verbs, agree, adjs, nouns).map((f) => `${t.slice(f.from, f.to)}→${f.replacement}`);

test("kongruens: køn, t-form og bestemt form", () => {
  assert.deepEqual(fixK("Vi købte en hus."), ["en→et"]);
  assert.deepEqual(fixK("Hun blev en offer for svindel."), ["en→et"]);
  assert.deepEqual(fixK("Det er et stor hus."), ["stor→stort"]);
  assert.deepEqual(fixK("Hun har en stort bil."), ["stort→stor"]);
  assert.deepEqual(fixK("Vi bor i det stor hus."), ["stor→store"]);
  assert.deepEqual(fixK("Det er et stort hus og en stor bil."), []);
  assert.deepEqual(fixK("Det er en vigtig sag og et vigtig problem."), ["vigtig→vigtigt"]);
});

test("kongruens: »det enkelt menneske« → »enkelte«, ikke »enkle« (målebænken 12/10)", () => {
  assert.deepEqual(fixK("Det er til gode for det enkelt menneske."), ["enkelt→enkelte"]);
  assert.deepEqual(fixK("Det er til gode for det enkelte menneske."), []);
  assert.deepEqual(fixK("Der var en enkelt undtagelse."), []);
});

test("kongruens: navne og ukendte ord markeres ikke", () => {
  assert.deepEqual(fixK("Han læser en Politiken."), []);
  assert.deepEqual(fixK("Det er et dansk hus."), []);
});

test("kongruens: falske fund fra korpusset markeres ikke", () => {
  assert.deepEqual(fixK("da en dansk avis skrev det"), []);
  assert.deepEqual(fixK("i et helt år"), []);
  assert.deepEqual(fixK("Det skriver forfatterne til en ny bog."), []);
  assert.deepEqual(fixK("For at være et marked kræver det fri konkurrence."), []);
});

const fixC = (t: string, comma: string) => grammarFlags(t, verbs, undefined, undefined, undefined, comma).filter((f) => f.kind === "grammatik:komma").map((f) => `${t.slice(f.from, f.to)}→${f.replacement}`);

test("komma efter en ledsætning først gælder i begge systemer", () => {
  assert.deepEqual(fixC("Når han kommer går vi.", "uden"), ["kommer→kommer,"]);
  assert.deepEqual(fixC("Hvis du vil kan vi tage den.", "start"), ["vil→vil,"]);
  assert.deepEqual(fixC("Når han kommer, går vi.", "start"), []);
});

test("med startkomma: komma foran »at« og foran hvis/når", () => {
  assert.deepEqual(fixC("Han sagde at hun var syg.", "start"), ["sagde→sagde,"]);
  assert.deepEqual(fixC("Vi går hjem hvis det regner.", "start"), ["hjem→hjem,"]);
  assert.deepEqual(fixC("Han sagde, at hun var syg.", "start"), []);
  assert.deepEqual(fixC("Det gælder især når det regner.", "start"), []);
  assert.deepEqual(fixC("Han sagde at gå.", "start"), []);
  assert.deepEqual(fixC("For hvis man frygter at dumme sig, går det galt.", "start"), []);
  assert.deepEqual(fixC("Det var fordi han var syg.", "start"), []);
  assert.deepEqual(fixC("hvordan de når dem", "start"), []);
  assert.deepEqual(fixC("Hun er ved at springe ud.", "start"), []);
  assert.deepEqual(fixC("For hvis man frygter at dumme sig, går det galt.", "start"), []);
  assert.deepEqual(fixC("Det var fordi han var syg.", "start"), []);
  assert.deepEqual(fixC("hvordan de når dem", "start"), []);
  assert.deepEqual(fixC("Hun er ved at springe ud.", "start"), []);
});

test("uden startkomma: kommaet foran »at« er unødvendigt", () => {
  assert.deepEqual(fixC("Han sagde, at hun var syg.", "uden"), [", → "]);
  assert.deepEqual(fixC("Han sagde at hun var syg.", "uden"), []);
  assert.deepEqual(fixC("Han sagde at hun var syg.", "fra"), []);
});

test("målebænken 12/10: »når« som udsagnsord, to bindeord i træk og blød bindestreg", () => {
  const comma = (t: string) => grammarFlags(t, verbs, undefined, undefined, new Set(["svin"]), "start").filter((f) => f.kind === "grammatik:komma").map((f) => t.slice(f.from, f.to));
  for (const t of ["Det er ikke sikkert, at alle når det.", "Vi ved, at mange når til samme resultat.", "Det betyder, at svin når ikke at vokse.", "Det viser, at DM når bredere ud."]) {
    assert.deepEqual(comma(t), [], t);
  }
  assert.deepEqual(comma("Vi går hjem fordi hvis det regner bliver vi våde."), ["hjem"]);
  assert.deepEqual(comma("Hun går hjem når det regner."), ["hjem"]);
  assert.deepEqual(fix("Vi må er­kende, at det gik galt."), []);
});

test("målebænken 12/10: kombinerende tegn deler ikke et ord, og biord foran bindeordet", () => {
  assert.deepEqual(fix("De har fået et lån."), []);
  const comma = (t: string) => grammarFlags(t, verbs, undefined, undefined, undefined, "start").filter((f) => f.kind === "grammatik:komma");
  assert.deepEqual(comma("Det gik galt, ganske enkelt fordi ingen svarede."), []);
  assert.deepEqual(comma("Det skete først og fremmest fordi de manglede penge."), []);
});

test("kommakonsistens: tekstens eget system vinder, de få afvigelser markeres (fase 2, 16/10)", () => {
  const kinds = (t: string, style: string) => grammarFlags(t, verbs, undefined, undefined, undefined, style).map((f) => `${f.kind}:${t.slice(f.from, f.to)}`);
  const uden = "Han siger at det regner. Hun mener at vi skal gå. De tror at han kommer. Han sagde, at det var godt.";
  assert.deepEqual(kinds(uden, "start"), ["ro:komma-konsistens:, "]);
  const med = "Han siger, at det regner. Hun mener, at vi skal gå. De tror, at han kommer. Han sagde at det var godt.";
  assert.deepEqual(kinds(med, "uden"), ["ro:komma-konsistens:sagde"]);
  // Under tre steder er der intet mønster, og det valgte system gælder.
  assert.deepEqual(kinds("Han siger at det regner. Hun mener, at vi skal gå.", "start"), ["grammatik:komma:siger"]);
});
