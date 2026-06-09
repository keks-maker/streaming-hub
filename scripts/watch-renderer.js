const esbuild = require('esbuild');
const path = require('path');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: [path.join(__dirname, '..', 'renderer.js')],
    outfile: path.join(__dirname, '..', 'dist', 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    sourcemap: true,
    target: ['es2020'],
    external: ['electron'],
  });

  await ctx.watch();
  console.log('👁  esbuild watching renderer.js – rebuild on change');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
