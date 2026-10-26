// Generates apps/web/src/styles/tokens.css from design-system/tokens.json.
// Run after pulling a new design-system export: `npm run tokens`.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tokens = JSON.parse(readFileSync(`${root}design-system/tokens.json`, "utf8"));

const light = [];
const dark = [];
const add = (name, value) => {
  if (value && typeof value === "object" && "light" in value) {
    light.push(`  --${name}: ${value.light};`);
    dark.push(`  --${name}: ${value.dark};`);
  } else {
    light.push(`  --${name}: ${value};`);
  }
};

for (const t of tokens.color.tokens) add(t.name, t.value);
for (const [name, value] of Object.entries(tokens.type.families)) add(`font-${name}`, value);
for (const group of ["spacing", "radius", "shadow", "size", "duration"]) {
  for (const t of tokens[group]?.tokens ?? []) add(t.name, t.value);
}

const css = `/* Generated from design-system/tokens.json by scripts/build-tokens.mjs. Do not edit. */
:root {
${light.join("\n")}
}
:root[data-theme="dark"] {
  color-scheme: dark;
${dark.join("\n")}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${dark.map((l) => "  " + l).join("\n")}
  }
}
`;

mkdirSync(`${root}apps/web/src/styles`, { recursive: true });
writeFileSync(`${root}apps/web/src/styles/tokens.css`, css);
copyFileSync(`${root}design-system/components.css`, `${root}apps/web/src/styles/components.css`);
console.log("Wrote apps/web/src/styles/tokens.css and components.css");
