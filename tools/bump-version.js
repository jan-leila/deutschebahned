// Bump the minor version in package.json (Pebble only uses major.minor) and print the new version.
// usage: node tools/bump-version.js [package.json]
const fs = require('fs');
const file = process.argv[2] || 'package.json';
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const [major, minor] = pkg.version.split('.').map(Number);
pkg.version = `${major}.${minor + 1}.0`;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(pkg.version);
