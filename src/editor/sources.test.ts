import { test } from "node:test";
import assert from "node:assert/strict";
import { clippingText, footnoteText, fragmentUrl, type Source } from "./sources.ts";

const src: Source = {
  title: "Folketal [1. kvartal]",
  url: "https://www.dst.dk/da/Statistik/emner/borgere#top",
  quote: "Folketallet var 5.961.249 den 1. januar 2024",
  publisher: "Danmarks Statistik",
  date: "11. februar 2024",
  check: "fundet",
};

test("link springer til citatet, bindestreg og komma kodes", () => {
  assert.equal(fragmentUrl("https://x.dk/a#b", "et kort-citat, her"), "https://x.dk/a#:~:text=et%20kort%2Dcitat%2C%20her");
  const long = fragmentUrl("https://x.dk", "en to tre fire fem seks syv otte ni ti elleve tolv");
  assert.equal(long, "https://x.dk#:~:text=en%20to%20tre%20fire%20fem,otte%20ni%20ti%20elleve%20tolv");
});

test("fodnote med udgiver, link, dato og hentet-dato", () => {
  const f = footnoteText(src, new Date(2026, 9, 2));
  assert.equal(
    f,
    "Danmarks Statistik: [Folketal 1. kvartal](https://www.dst.dk/da/Statistik/emner/borgere#:~:text=Folketallet%20var%205.961.249%20den%201.%20januar%202024), 11. februar 2024 (hentet 2. okt. 2026)",
  );
});

test("et citat, der ikke står på siden, kommer aldrig med som citat", () => {
  const clip = clippingText({ ...src, check: "ikke_fundet" }, "Resumé.");
  assert.ok(!clip.includes("»"));
  assert.ok(clip.startsWith("Resumé."));
  assert.ok(!footnoteText({ ...src, check: "ikke_fundet" }).includes(":~:text="));
});
