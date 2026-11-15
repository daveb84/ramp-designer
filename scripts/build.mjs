// Builds the site into dist/ as plain static files, for hosting without a Node server.
//
// The app's scripts share their top-level names with each other (physics.js uses functions from ramp.js, and so on),
// as classic scripts in one page do. So rather than bundling them as modules, the build joins them in the order the
// page loads them and minifies the result as one script. The stylesheet is minified, the physics library is copied
// in, and each file is named by a hash of its contents so browsers always fetch the current version.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'public');
const dist = path.join(root, 'dist');
const planckDir = path.join(root, 'node_modules', 'planck');

const hashed = (name, contents) => {
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 8);
  const { name: base, ext } = path.parse(name);
  return `${base}.${hash}${ext}`;
};

const html = await readFile(path.join(source, 'index.html'), 'utf8');

// The app's own scripts, in the order the page loads them. The physics library is copied separately.
const scriptTags = [...html.matchAll(/<script src="([^"]+)"><\/script>\n?/g)];
const appScripts = scriptTags.map((tag) => tag[1]).filter((src) => !src.startsWith('vendor/'));
const joined = (await Promise.all(appScripts.map((src) => readFile(path.join(source, src), 'utf8'))))
  .map((code, i) => `// ${appScripts[i]}\n${code}`)
  .join('\n');
const app = await transform(joined, { loader: 'js', minify: true, format: 'iife', target: 'es2020' });

const css = await transform(await readFile(path.join(source, 'styles.css'), 'utf8'), { loader: 'css', minify: true });

const planckPath = path.join(planckDir, 'dist', 'planck.min.js');
const planckVersion = JSON.parse(await readFile(path.join(planckDir, 'package.json'), 'utf8')).version;
const planckName = `planck-${planckVersion}.min.js`;

const appName = hashed('app.js', app.code);
const cssName = hashed('styles.css', css.code);

// The page, pointing at the built files: the scripts replaced by the library and the joined app.
const firstScript = scriptTags[0].index;
const lastScript = scriptTags[scriptTags.length - 1];
const builtHtml = html.slice(0, firstScript)
  + `<script src="vendor/${planckName}"></script>\n  <script src="${appName}"></script>\n`
  + html.slice(lastScript.index + lastScript[0].length);
if (!builtHtml.includes('href="styles.css"')) throw new Error('index.html no longer links styles.css');

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'vendor'), { recursive: true });
await Promise.all([
  writeFile(path.join(dist, 'index.html'), builtHtml.replace('href="styles.css"', `href="${cssName}"`)),
  writeFile(path.join(dist, appName), app.code),
  writeFile(path.join(dist, cssName), css.code),
  copyFile(planckPath, path.join(dist, 'vendor', planckName)),
]);

const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`;
console.log(`Built dist/: ${appName} (${kb(app.code)}, from ${appScripts.join(', ')}), ${cssName} (${kb(css.code)}), vendor/${planckName}`);
