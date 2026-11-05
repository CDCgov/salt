// First administrator: random one-time password, forced change, saved file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3');
const {
    generateInitialPassword, initialPasswordFile, writeInitialPasswordFile,
    removeInitialPasswordFile, newPasswordProblem, MIN_PASSWORD_LENGTH
} = require('../src/services/firstLogin');

const tempDbPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'salt-first-')), 'data', 'database', 'salt.db');

test('one-time passwords are random and easy to type', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
        const p = generateInitialPassword();
        assert.match(p, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
        seen.add(p);
    }
    assert.equal(seen.size, 200);
});

test('new password rules', () => {
    assert.match(newPasswordProblem('short', 'x'), new RegExp(`at least ${MIN_PASSWORD_LENGTH}`));
    assert.match(newPasswordProblem('the-same-password', 'the-same-password'), /different/);
    assert.equal(newPasswordProblem('a-new-long-password', 'old-one'), null);
});

test('saved password file is private and only removed for its own account', () => {
    const dbPath = tempDbPath();
    fs.mkdirSync(path.dirname(path.dirname(dbPath)), { recursive: true });
    const file = writeInitialPasswordFile(dbPath, 'admin', 'abcd-efgh-jkmn-pqrs');
    assert.equal(file, initialPasswordFile(dbPath));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    removeInitialPasswordFile(dbPath, 'someone_else');
    assert.ok(fs.existsSync(file));
    removeInitialPasswordFile(dbPath, 'admin');
    assert.ok(!fs.existsSync(file));
    removeInitialPasswordFile(dbPath, 'admin'); // already gone: no error
});

test('a fresh database gets an admin with a random one-time password', async () => {
    const dbPath = tempDbPath();
    const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'init-database.js')],
        { env: { ...process.env, SALT_DB_PATH: dbPath }, encoding: 'utf8', timeout: 120000 });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout, /admin123/);
    const file = initialPasswordFile(dbPath);
    const password = fs.readFileSync(file, 'utf8').match(/^password: (.+)$/m)[1];
    assert.ok(first.stdout.includes(password), 'password is shown once in the output');

    const db = new sqlite3.Database(dbPath);
    const row = await new Promise((resolve, reject) =>
        db.get("SELECT password_hash, must_change_password, role FROM admin_users WHERE username = 'admin'", (e, r) => e ? reject(e) : resolve(r)));
    assert.equal(row.must_change_password, 1);
    assert.equal(row.role, 'administrator');
    assert.ok(await bcrypt.compare(password, row.password_hash));
    assert.ok(!(await bcrypt.compare('admin123', row.password_hash)));

    // Running it again (every start does) keeps the account and the file.
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.ok(fs.readFileSync(file, 'utf8').includes(password));
    const count = await new Promise((resolve, reject) =>
        db.get('SELECT COUNT(*) AS n FROM admin_users', (e, r) => e ? reject(e) : resolve(r.n)));
    assert.equal(count, 1);
    db.close();
});

test('reset-admin-password gives an account a new one-time password', async () => {
    const dbPath = tempDbPath();
    const node = (script, args = []) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args],
        { env: { ...process.env, SALT_DB_PATH: dbPath }, encoding: 'utf8', timeout: 120000 });
    assert.equal(node('init-database.js').status, 0);
    const db = new sqlite3.Database(dbPath);
    const q = (s) => new Promise((resolve, reject) => db.get(s, (e, r) => e ? reject(e) : resolve(r)));
    await new Promise((resolve, reject) => db.exec(
        "UPDATE admin_users SET must_change_password = 0, is_active = 0 WHERE username = 'admin';" +
        "INSERT INTO admin_users (username, password_hash, role) VALUES ('other', 'x', 'administrator');",
        e => e ? reject(e) : resolve()));

    const out = node('reset-admin-password.js', ['admin']);
    assert.equal(out.status, 0, out.stderr);
    const password = out.stdout.match(/One-time password for "admin": (\S+)/)[1];
    const row = await q("SELECT password_hash, must_change_password, is_active FROM admin_users WHERE username = 'admin'");
    assert.equal(row.must_change_password, 1);
    assert.equal(row.is_active, 1);
    assert.ok(await bcrypt.compare(password, row.password_hash));
    assert.equal((await q("SELECT must_change_password FROM admin_users WHERE username = 'other'")).must_change_password, 0);

    const created = node('reset-admin-password.js', ['newadmin']);
    assert.match(created.stdout, /Created administrator "newadmin"/);
    assert.equal((await q("SELECT role, must_change_password FROM admin_users WHERE username = 'newadmin'")).must_change_password, 1);
    db.close();
});
