// Environment passed to R / Quarto: what R needs, never the server's secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { childProcessEnv } = require('../src/services/childProcessEnv');

const SERVER_ENV = {
    PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', LANG: 'C', LC_ALL: 'C.UTF-8', TMPDIR: '/tmp',
    R_HOME: '/usr/lib/R', R_LIBS_SITE: '/usr/local/lib/R/site-library', QUARTO_VERSION: '1.9.37',
    XDG_CACHE_HOME: '/root/.cache',
    SESSION_SECRET: 's', MCP_PUBLIC_URL: 'https://x', NODE_ENV: 'production', PORT: '3000',
    R_SECRET_TOKEN: 'leak', QUARTO_API_KEY: 'leak', AWS_SECRET_ACCESS_KEY: 'leak', DATABASE_URL: 'leak'
};

test('passes through what R and Quarto need', () => {
    const env = childProcessEnv({}, SERVER_ENV);
    for (const k of ['PATH', 'HOME', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'R_HOME', 'R_LIBS_SITE', 'QUARTO_VERSION', 'XDG_CACHE_HOME']) {
        assert.equal(env[k], SERVER_ENV[k], k);
    }
});

test('drops server settings and anything that looks like a secret', () => {
    const env = childProcessEnv({}, SERVER_ENV);
    for (const k of ['SESSION_SECRET', 'MCP_PUBLIC_URL', 'NODE_ENV', 'PORT', 'R_SECRET_TOKEN', 'QUARTO_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']) {
        assert.equal(env[k], undefined, k);
    }
});

test('overrides win', () => {
    assert.equal(childProcessEnv({ LANG: 'en_US.UTF-8' }, SERVER_ENV).LANG, 'en_US.UTF-8');
});

test('defaults to the real process environment', () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'zz';
    try {
        const env = childProcessEnv();
        assert.equal(env.SESSION_SECRET, undefined);
        assert.equal(env.PATH, process.env.PATH);
    } finally {
        if (saved === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = saved;
    }
});
