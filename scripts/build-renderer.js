const esbuild = require('esbuild');
const path = require('path');

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'renderer.js')],
    outfile: path.join(__dirname, '..', 'dist', 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    sourcemap: true,
    target: ['es2020'],
    external: ['electron'],
  });

  if (result.errors.length) {
    console.error('Build failed:', result.errors);
    process.exit(1);
  }
  console.log('✓ dist/renderer.js built successfully');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
