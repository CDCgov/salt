// The server's required tablet version (src/services/tabletVersion.js) must
// exist: the tablet app in this repo has to be at least that version.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MIN_TABLET_VERSION_CODE, MIN_TABLET_VERSION_NAME } = require('../src/services/tabletVersion');

const GRADLE = path.join(__dirname, '..', '..', 'salt_android', 'app', 'build.gradle.kts');

test('tablet app is at least the version the server requires', { skip: !fs.existsSync(GRADLE) && 'salt_android not present' }, () => {
    const gradle = fs.readFileSync(GRADLE, 'utf8');
    const code = Number(gradle.match(/versionCode\s*=\s*(\d+)/)[1]);
    const name = gradle.match(/versionName\s*=\s*"([^"]+)"/)[1];
    assert.ok(code >= MIN_TABLET_VERSION_CODE, `build.gradle.kts versionCode ${code} is below the server's MIN_TABLET_VERSION_CODE ${MIN_TABLET_VERSION_CODE}`);
    if (code === MIN_TABLET_VERSION_CODE) assert.equal(name, MIN_TABLET_VERSION_NAME, 'versionName should match MIN_TABLET_VERSION_NAME for the same versionCode');
});
