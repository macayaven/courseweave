import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    listenOnUnixSocket,
    liveProviderConfiguration,
    parseVerifierArgs,
    providerModeArguments,
    resolveVerifierPaths,
    studyHomeForRelease,
    validateUnixHandoffPath,
} from './verify-student-release-cli.mjs';

const localRoot = process.env.COURSEWEAVE_TEST_ROOT ?? (process.platform === 'darwin' ? '/tmp' : tmpdir());

async function fixture() {
    const root = await realpath(await mkdtemp(join(localRoot, 'cv-')));
    const release = join(root, 'release');
    const evidence = join(root, 'evidence');
    const testRoot = join(root, 'scratch');
    await mkdir(release);
    await mkdir(testRoot);
    return { root, release, evidence, testRoot };
}

test('omitting live flags selects synthetic-only acceptance', () => {
    const parsed = parseVerifierArgs(['release', 'evidence', '--test-root', 'scratch']);
    assert.deepEqual(parsed, {
        release: 'release',
        evidence: 'evidence',
        testRoot: 'scratch',
        mode: 'synthetic',
        help: false,
    });
    assert.equal(parseVerifierArgs(['release', 'evidence', '--test-root', 'scratch', '--no-live']).mode, 'synthetic');
    assert.equal(parseVerifierArgs(['release', 'evidence', '--test-root', 'scratch', '--live-only']).mode, 'live');
});

test('test root is required and live modes are mutually exclusive', () => {
    assert.throws(
        () => parseVerifierArgs(['release', 'evidence']),
        /--test-root is required/,
    );
    assert.throws(
        () => parseVerifierArgs(['release', 'evidence', '--test-root', 'scratch', '--no-live', '--live-only']),
        /mutually exclusive/,
    );
    assert.throws(
        () => parseVerifierArgs(['release', 'evidence', '--test-root', 'scratch', '--unknown']),
        /Unknown option: --unknown/,
    );
});

test('help exits before acceptance and documents the portable interface', () => {
    const result = spawnSync(
        process.execPath,
        ['--experimental-transform-types', 'scripts/verify_student_release.mjs', '--help'],
        { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RELEASE EVIDENCE --test-root ROOT/);
    assert.match(result.stdout, /Omitting both live flags runs synthetic acceptance only/);
    assert.match(result.stdout, /COURSEWEAVE_PROVIDER=openai\|anthropic/);
});

test('safe paths resolve through aliases while a common test-root parent remains allowed', async t => {
    const paths = await fixture();
    t.after(() => rm(paths.root, { recursive: true, force: true }));
    const releaseAlias = join(paths.root, 'release-alias');
    await symlink(paths.release, releaseAlias);

    const resolved = await resolveVerifierPaths({
        release: releaseAlias,
        evidence: paths.evidence,
        testRoot: paths.root,
    });

    assert.equal(resolved.release, paths.release);
    assert.equal(resolved.evidence, paths.evidence);
    assert.equal(resolved.testRoot, paths.root);
    await assert.rejects(readFile(paths.evidence), /ENOENT/);
});

test('Unix handoff validation counts UTF-8 bytes and accepts a short root', () => {
    assert.doesNotThrow(() => validateUnixHandoffPath(`/tmp/${'e'.repeat(30)}`));
    assert.throws(
        () => validateUnixHandoffPath(`/tmp/${'é'.repeat(30)}`),
        /Unix handoff socket.*UTF-8 bytes.*maximum 103.*shorter nonsynced --test-root/s,
    );
});

test('overlong existing test root fails CLI preflight without creating evidence or test children', async t => {
    const paths = await fixture();
    t.after(() => rm(paths.root, { recursive: true, force: true }));
    const testRoot = join(paths.testRoot, 'é'.repeat(30));
    await mkdir(testRoot);

    const result = spawnSync(
        process.execPath,
        [
            '--experimental-transform-types',
            'scripts/verify_student_release.mjs',
            paths.release,
            paths.evidence,
            '--test-root',
            testRoot,
            '--no-live',
        ],
        {
            cwd: new URL('../..', import.meta.url),
            encoding: 'utf8',
            env: { HOME: process.env.HOME, PATH: process.env.PATH },
        },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unix handoff socket.*UTF-8 bytes.*maximum 103.*shorter nonsynced --test-root/s);
    await assert.rejects(readFile(paths.evidence), /ENOENT/);
    assert.deepEqual(await readdir(testRoot), []);
});

test('Unix socket bind failures reject normally and preserve the existing socket', async t => {
    const paths = await fixture();
    const socket = join(paths.testRoot, 'bootstrap.sock');
    const owner = createServer();
    t.after(async () => {
        await new Promise(resolveClose => owner.close(resolveClose));
        await rm(paths.root, { recursive: true, force: true });
    });
    await listenOnUnixSocket(owner, socket);

    const contender = createServer();
    await assert.rejects(
        listenOnUnixSocket(contender, socket),
        error => error?.code === 'EADDRINUSE',
    );

    assert.deepEqual(await readdir(paths.testRoot), ['bootstrap.sock']);
});

test('cloud-shaped paths are rejected without creating or traversing real cloud storage', async t => {
    const paths = await fixture();
    t.after(() => rm(paths.root, { recursive: true, force: true }));
    const cases = [
        join(paths.root, 'Library', 'Mobile Documents', 'evidence'),
        join(paths.root, 'Library', 'CloudStorage', 'GoogleDrive-example', 'evidence'),
    ];
    for (const evidence of cases) {
        await assert.rejects(
            resolveVerifierPaths({ release: paths.release, evidence, testRoot: paths.testRoot }),
            /evidence resolves inside cloud-synced storage/,
        );
        await assert.rejects(readFile(evidence), /ENOENT/);
    }
    const fakeCloud = join(paths.root, 'Library', 'CloudStorage', 'GoogleDrive-example');
    const alias = join(paths.root, 'cloud-alias');
    await mkdir(fakeCloud, { recursive: true });
    await symlink(fakeCloud, alias);
    await assert.rejects(
        resolveVerifierPaths({ release: paths.release, evidence: join(alias, 'evidence'), testRoot: paths.testRoot }),
        /evidence resolves inside cloud-synced storage/,
    );
});

test('release, evidence, and disposable-root overlaps are rejected before evidence writes', async t => {
    const paths = await fixture();
    t.after(() => rm(paths.root, { recursive: true, force: true }));
    const cases = [
        { evidence: join(paths.release, 'evidence'), testRoot: paths.testRoot },
        { evidence: paths.evidence, testRoot: join(paths.release, 'scratch') },
        { evidence: paths.evidence, testRoot: paths.evidence },
    ];
    for (const candidate of cases) {
        await assert.rejects(
            resolveVerifierPaths({ release: paths.release, ...candidate }),
            /overlap/,
        );
        await assert.rejects(readFile(candidate.evidence), /ENOENT/);
    }
});

test('generic bundle identity selects the actual course-specific default home', () => {
    const release = { format_version: 2, course_id: 'agent-harness-path', course_version: '0.2.0',
        files: { course: { sha256: 'a'.repeat(64) } } };
    assert.equal(studyHomeForRelease('/safe/os-home', release, 'darwin'),
        '/safe/os-home/Library/Application Support/CourseWeave/agent-harness-path-v0.2.0-aaaaaaaaaaaaaaaa');
    assert.throws(() => studyHomeForRelease('/safe/os-home', { ...release, course_id: '../escape' }, 'darwin'), /identity/);
    assert.throws(() => studyHomeForRelease('/safe/os-home', { ...release, files: {} }, 'darwin'), /identity/);
});

test('release course_version selects the tested macOS default study home', () => {
    assert.equal(
        studyHomeForRelease('/safe/os-home', { course_version: '0.2.0' }, 'darwin'),
        '/safe/os-home/Library/Application Support/CourseWeave/Agent Harness Path v0.2.0',
    );
    assert.throws(
        () => studyHomeForRelease('/safe/os-home', { course_version: '../old' }, 'darwin'),
        /missing or unsafe course version/,
    );
});

test('live-only selects one explicit provider configuration and keeps its key in memory', () => {
    const source = {
        COURSEWEAVE_PROVIDER: 'anthropic',
        ANTHROPIC_MODEL: 'claude-example',
        ANTHROPIC_API_KEY: 'anthropic-memory-only-canary',
        ANTHROPIC_BASE_URL: 'https://provider.example/v1',
        OPENAI_MODEL: 'unrelated-model',
        OPENAI_API_KEY: 'unrelated-key',
        COURSEWEAVE_CAPABILITY_TOKEN: 'unrelated-token',
        COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS: '45',
    };

    const selected = liveProviderConfiguration(source);

    assert.deepEqual(selected.environment, {
        COURSEWEAVE_PROVIDER: 'anthropic',
        COURSEWEAVE_PROVIDER_PROFILE: 'text-only-v1',
        ANTHROPIC_MODEL: 'claude-example',
        ANTHROPIC_API_KEY: 'anthropic-memory-only-canary',
        ANTHROPIC_BASE_URL: 'https://provider.example/v1',
        COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS: '45',
    });
    assert.equal(selected.credential, 'anthropic-memory-only-canary');
    assert.equal(JSON.stringify(selected).includes('unrelated-key'), false);
    assert.equal(JSON.stringify(selected).includes('unrelated-token'), false);
    assert.deepEqual(providerModeArguments({ providerEnvironment: selected.environment }), ['--provider-env']);
});

test('synthetic and restart launches retain explicit provider modes', () => {
    assert.deepEqual(providerModeArguments({ synthetic: true }), ['--provider-env']);
    assert.deepEqual(providerModeArguments({ noProvider: true }), ['--no-provider']);
    assert.deepEqual(providerModeArguments(), []);
    assert.throws(
        () => providerModeArguments({ synthetic: true, noProvider: true }),
        /mutually exclusive/,
    );
});

test('live-only rejects missing selected-provider configuration without fallback', () => {
    assert.throws(
        () => liveProviderConfiguration({
            COURSEWEAVE_PROVIDER: 'openai',
            OPENAI_MODEL: 'gpt-example',
            ANTHROPIC_API_KEY: 'wrong-provider-key',
        }),
        /OPENAI_API_KEY/,
    );
    assert.throws(
        () => liveProviderConfiguration({
            OPENAI_MODEL: 'gpt-example',
            OPENAI_API_KEY: 'key',
        }),
        /COURSEWEAVE_PROVIDER=openai or anthropic/,
    );
});

test('missing live configuration fails before evidence or a disposable home is created', async t => {
    const paths = await fixture();
    t.after(() => rm(paths.root, { recursive: true, force: true }));
    const result = spawnSync(
        process.execPath,
        [
            '--experimental-transform-types',
            'scripts/verify_student_release.mjs',
            paths.release,
            paths.evidence,
            '--test-root',
            paths.testRoot,
            '--live-only',
        ],
        {
            cwd: new URL('../..', import.meta.url),
            encoding: 'utf8',
            env: { HOME: process.env.HOME, PATH: process.env.PATH },
        },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COURSEWEAVE_PROVIDER=openai or anthropic/);
    await assert.rejects(readFile(paths.evidence), /ENOENT/);
    assert.deepEqual(await readdir(paths.testRoot), []);
});
