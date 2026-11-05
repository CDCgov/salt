// Session cookie secret: SESSION_SECRET, else a random one kept in a file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSessionSecret } = require('../src/services/sessionSecret');

function withEnv(value, fn) {
    const saved = process.env.SESSION_SECRET;
    if (value === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = value;
    try { return fn(); } finally {
        if (saved === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved;
    }
}

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'salt-secret-')), 'data', '.session-secret');

test('SESSION_SECRET wins and no file is written', () => {
    const file = tempFile();
    assert.equal(withEnv('from-env', () => getSessionSecret(file)), 'from-env');
    assert.equal(fs.existsSync(file), false);
});

test('without SESSION_SECRET a random secret is generated once, saved privately and reused', () => {
    const file = tempFile();
    const first = withEnv(undefined, () => getSessionSecret(file));
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(withEnv('  ', () => getSessionSecret(file)), first, 'blank SESSION_SECRET counts as unset');
    assert.notEqual(withEnv(undefined, () => getSessionSecret(tempFile())), first, 'each install gets its own secret');
});

test('an existing secret file is used as is', () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'abc123\n');
    assert.equal(withEnv(undefined, () => getSessionSecret(file)), 'abc123');
});

test('app.js has no built-in fallback secret', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(app, /secret: getSessionSecret\(\)/);
    assert.doesNotMatch(app, /change-in-production/);
});
