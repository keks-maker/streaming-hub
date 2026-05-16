const fs = require('fs');
const path = require('path');

console.log('Setting up Castlabs Electron for Widevine DRM support...');

const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

if (pkg.devDependencies && pkg.devDependencies['@castlabs/electron-releases']) {
  console.log('Castlabs Electron configured in package.json');
  console.log('');
  console.log('IMPORTANT: Run "npm install" to install Castlabs Electron.');
  console.log('Castlabs Electron includes Widevine CDM with VMP support.');
  console.log('');
  console.log('For production builds with full Netflix support:');
  console.log('  1. Sign up at https://castlabs.com/account/register');
  console.log('  2. Install evs: npm install -g @castlabs/evs');
  console.log('  3. Run: evs setup');
  console.log('  4. Build and sign your app');
} else {
  console.log('ERROR: @castlabs/electron-releases not found in package.json');
}
