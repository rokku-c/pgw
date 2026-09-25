import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import zh from "../src/web/locales/zh-CN";
import en from "../src/web/locales/en-US";

const keys = Object.keys(zh) as (keyof typeof zh)[];
assert.deepEqual([...keys].sort(), Object.keys(en).sort());
const parameters = (value: string) =>
  [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();
const files = (await readdir("src/web")).filter((file) =>
  /\.(ts|tsx)$/.test(file),
);
const source = (
  await Promise.all(files.map((file) => Bun.file(`src/web/${file}`).text()))
).join("\n");
const unused: string[] = [];
for (const key of keys) {
  assert.match(key, /^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/);
  assert.ok(zh[key].trim() && en[key].trim(), key);
  assert.deepEqual(parameters(zh[key]), parameters(en[key]), key);
  if (!source.includes(`"${key}"`) && !source.includes(`'${key}'`)) unused.push(key);
}
console.log(`${keys.length} keys · zh-CN / en-US · verified${unused.length ? ` · ${unused.length} unused` : ""}`);
