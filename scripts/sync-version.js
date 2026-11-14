import fs from 'node:fs';
import path from 'node:path';

const rawArg = process.argv[2];

if (!rawArg) {
  console.error('Error: Version or tag argument required.');
  console.error('Usage: node scripts/sync-version.js <vX.Y.Z or X.Y.Z>');
  process.exit(1);
}

// Strictly validate tag (vX.Y.Z) or raw semver (X.Y.Z)
// MAJOR.MINOR.PATCH with no leading zeros (unless 0 itself)
const tagRegex = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

let version;
let tagName;

if (rawArg.startsWith('v')) {
  if (!tagRegex.test(rawArg)) {
    console.error(`[VALIDATION FAILED] Tag '${rawArg}' is invalid. Releases must strictly match 'vMAJOR.MINOR.PATCH' (e.g., v0.0.1).`);
    process.exit(1);
  }
  version = rawArg.slice(1);
  tagName = rawArg;
} else {
  if (!semverRegex.test(rawArg)) {
    console.error(`[VALIDATION FAILED] Version '${rawArg}' is invalid. Must strictly match 'MAJOR.MINOR.PATCH' (e.g., 0.0.1).`);
    process.exit(1);
  }
  version = rawArg;
  tagName = `v${rawArg}`;
}

console.log(`[INFO] Validated release tag: ${tagName}`);
console.log(`[INFO] Synchronizing application version across project to: ${version}`);

// 1. Synchronize package.json
const pkgPath = path.resolve('package.json');
if (fs.existsSync(pkgPath)) {
  const pkgContent = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgContent);
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`[OK] Updated package.json version -> ${version}`);
}

// 2. Synchronize package-lock.json
const pkgLockPath = path.resolve('package-lock.json');
if (fs.existsSync(pkgLockPath)) {
  const pkgLockContent = fs.readFileSync(pkgLockPath, 'utf8');
  const pkgLock = JSON.parse(pkgLockContent);
  pkgLock.version = version;
  if (pkgLock.packages && pkgLock.packages['']) {
    pkgLock.packages[''].version = version;
  }
  fs.writeFileSync(pkgLockPath, JSON.stringify(pkgLock, null, 2) + '\n', 'utf8');
  console.log(`[OK] Updated package-lock.json version -> ${version}`);
}

// 3. Synchronize src-tauri/tauri.conf.json
const tauriConfPath = path.resolve('src-tauri/tauri.conf.json');
if (fs.existsSync(tauriConfPath)) {
  const tauriContent = fs.readFileSync(tauriConfPath, 'utf8');
  const tauriConf = JSON.parse(tauriContent);
  tauriConf.version = version;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
  console.log(`[OK] Updated src-tauri/tauri.conf.json version -> ${version}`);
}

// 4. Synchronize src-tauri/Cargo.toml
const cargoTomlPath = path.resolve('src-tauri/Cargo.toml');
if (fs.existsSync(cargoTomlPath)) {
  let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  const updatedCargoToml = cargoToml.replace(
    /(\[package\][\s\S]*?version\s*=\s*")[^"]+(")/,
    `$1${version}$2`
  );
  if (cargoToml === updatedCargoToml && !cargoToml.includes(`version = "${version}"`)) {
    console.error(`[ERROR] Could not find or replace [package] version in ${cargoTomlPath}`);
    process.exit(1);
  }
  fs.writeFileSync(cargoTomlPath, updatedCargoToml, 'utf8');
  console.log(`[OK] Updated src-tauri/Cargo.toml version -> ${version}`);
}

// 5. Synchronize src-tauri/Cargo.lock
const cargoLockPath = path.resolve('src-tauri/Cargo.lock');
if (fs.existsSync(cargoLockPath)) {
  let cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  const updatedCargoLock = cargoLock.replace(
    /(name\s*=\s*"messenger"\r?\nversion\s*=\s*")[^"]+(")/,
    `$1${version}$2`
  );
  if (cargoLock === updatedCargoLock && !cargoLock.includes(`version = "${version}"`)) {
    console.error(`[ERROR] Could not find or replace messenger package version in ${cargoLockPath}`);
    process.exit(1);
  }
  fs.writeFileSync(cargoLockPath, updatedCargoLock, 'utf8');
  console.log(`[OK] Updated src-tauri/Cargo.lock version -> ${version}`);
}

// 6. Verify all version declarations match
console.log(`\n[INFO] Verifying all version declarations...`);

// Verify package.json
const pkgVerify = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkgVerify.version !== version) {
  console.error(`[VERIFICATION FAILED] package.json version is '${pkgVerify.version}', expected '${version}'`);
  process.exit(1);
}

// Verify package-lock.json
if (fs.existsSync(pkgLockPath)) {
  const pkgLockVerify = JSON.parse(fs.readFileSync(pkgLockPath, 'utf8'));
  if (pkgLockVerify.version !== version || (pkgLockVerify.packages && pkgLockVerify.packages[''] && pkgLockVerify.packages[''].version !== version)) {
    console.error(`[VERIFICATION FAILED] package-lock.json version mismatch. Expected '${version}'`);
    process.exit(1);
  }
}

// Verify tauri.conf.json
const tauriVerify = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
if (tauriVerify.version !== version) {
  console.error(`[VERIFICATION FAILED] tauri.conf.json version is '${tauriVerify.version}', expected '${version}'`);
  process.exit(1);
}

// Verify Cargo.toml
const cargoTomlVerify = fs.readFileSync(cargoTomlPath, 'utf8');
const cargoMatch = cargoTomlVerify.match(/\[package\][\s\S]*?version\s*=\s*"([^"]+)"/);
if (!cargoMatch || cargoMatch[1] !== version) {
  console.error(`[VERIFICATION FAILED] Cargo.toml version is '${cargoMatch ? cargoMatch[1] : 'not found'}', expected '${version}'`);
  process.exit(1);
}

// Verify Cargo.lock
if (fs.existsSync(cargoLockPath)) {
  const cargoLockVerify = fs.readFileSync(cargoLockPath, 'utf8');
  const lockMatch = cargoLockVerify.match(/name\s*=\s*"messenger"\r?\nversion\s*=\s*"([^"]+)"/);
  if (!lockMatch || lockMatch[1] !== version) {
    console.error(`[VERIFICATION FAILED] Cargo.lock version is '${lockMatch ? lockMatch[1] : 'not found'}', expected '${version}'`);
    process.exit(1);
  }
}

console.log(`[ALL VERIFIED] All version declarations match: ${version}`);

// Export to GITHUB_OUTPUT if present
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tagName}\n`);
  console.log(`[INFO] Exported version=${version} and tag=${tagName} to GITHUB_OUTPUT`);
}
