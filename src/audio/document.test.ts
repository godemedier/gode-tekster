import { test } from "node:test";
import assert from "node:assert/strict";
import { audioLink, audioSource } from "./document.ts";
test("lydlinks accepterer tid og danske navne, aldrig adresser eller stier",()=>{
  assert.deepEqual(audioLink("m%C3%B8de.wav#t=3661.5"),{name:"møde.wav",seconds:3661.5});
  for(const link of ["https://example.com/a#t=1","..%2Fa.wav#t=1","C%3A.wav#t=1","a#t=NaN","a#t=999999"])assert.equal(audioLink(link),null);
});
test("lydkilden genåbnes fra md, aldrig fra kodeeksempler eller ugyldige metadata",()=>{
  const marker='<!-- gt:lyd {"version":1,"audio":"a.wav","duration":80,"complete":true} -->';
  assert.equal(audioSource(marker)?.audio,"a.wav");
  assert.equal(audioSource('```\n'+marker+'\n```'),null);
  assert.equal(audioSource(marker.replace('a.wav','../a.wav')),null);
});
