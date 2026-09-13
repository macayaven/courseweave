import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const VERIFIER_HELP = `Usage:
  node --experimental-transform-types scripts/verify_student_release.mjs RELEASE EVIDENCE --test-root ROOT [--no-live|--live-only]

RELEASE is an existing student bundle. EVIDENCE is the output directory. ROOT is
an existing nonsynced local directory where the verifier may create and remove one
disposable child home. ROOT must be short enough that the verifier's longest Unix
handoff socket path is at most 103 UTF-8 bytes; use a shorter nonsynced path when
needed. This limit applies only to the verifier test root, not package or study paths.

Omitting both live flags runs synthetic acceptance only. --no-live is the explicit
equivalent. --live-only runs only authorized real-provider text checks and requires
COURSEWEAVE_PROVIDER=openai|anthropic plus the selected provider's *_MODEL and
*_API_KEY variables; *_BASE_URL and documented COURSEWEAVE provider limits are
optional. Live configuration is passed to the launcher with --provider-env.
`;

export function parseVerifierArgs(argv) {
    if (argv.includes('--help') || argv.includes('-h'))
        return { help: true };
    const positional = [];
    let testRoot;
    let noLive = false;
    let liveOnly = false;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--test-root') {
            if (testRoot !== undefined)
                throw new Error('--test-root may only be supplied once.');
            const value = argv[++index];
            if (!value || value.startsWith('-'))
                throw new Error('--test-root requires a path.');
            testRoot = value;
        }
        else if (argument === '--no-live')
            noLive = true;
        else if (argument === '--live-only')
            liveOnly = true;
        else if (argument.startsWith('-'))
            throw new Error(`Unknown option: ${argument}`);
        else
            positional.push(argument);
    }
    if (noLive && liveOnly)
        throw new Error('--no-live and --live-only are mutually exclusive.');
    if (testRoot === undefined)
        throw new Error('--test-root is required.');
    if (positional.length !== 2)
        throw new Error('Expected RELEASE and EVIDENCE positional paths.');
    return {
        release: positional[0],
        evidence: positional[1],
        testRoot,
        mode: liveOnly ? 'live' : 'synthetic',
        help: false,
    };
}

async function canonicalPath(path) {
    const absolute = resolve(path);
    const suffix = [];
    let existing = absolute;
    while (true) {
        try {
            const canonical = await realpath(existing);
            return resolve(canonical, ...suffix.reverse());
        }
        catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR')
                throw error;
            const parent = dirname(existing);
            if (parent === existing)
                throw error;
            suffix.push(existing.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
            existing = parent;
        }
    }
}

function isCloudPath(path) {
    const parts = resolve(path).split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
        if (parts[index] !== 'Library')
            continue;
        if (parts[index + 1] === 'Mobile Documents')
            return true;
        if (parts[index + 1] === 'CloudStorage' && parts[index + 2]?.startsWith('GoogleDrive-'))
            return true;
    }
    return false;
}

function contains(parent, child) {
    const tail = relative(parent, child);
    return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail));
}

const UNIX_HANDOFF_PATH_LIMIT_BYTES = 103;
const LONGEST_HANDOFF_PATH_SUFFIX = join(
    `courseweave-acceptance-${'x'.repeat(6)}`,
    `session-${'x'.repeat(6)}`,
    'bootstrap.sock',
);

export function validateUnixHandoffPath(testRoot) {
    const socketPath = join(resolve(testRoot), LONGEST_HANDOFF_PATH_SUFFIX);
    const byteLength = Buffer.byteLength(socketPath, 'utf8');
    if (byteLength > UNIX_HANDOFF_PATH_LIMIT_BYTES)
        throw new Error(
            `Unix handoff socket beneath test-root would be ${byteLength} UTF-8 bytes; ` +
            `maximum ${UNIX_HANDOFF_PATH_LIMIT_BYTES}. Use a shorter nonsynced --test-root. ` +
            'This verifier limit does not apply to package or study paths.',
        );
}

export async function listenOnUnixSocket(server, socketPath) {
    await new Promise((resolveListen, rejectListen) => {
        const onError = error => {
            server.off('listening', onListening);
            rejectListen(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath);
    });
}

async function requireDirectory(path, label) {
    let info;
    try {
        info = await stat(path);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            throw new Error(`${label} must be an existing directory.`);
        throw error;
    }
    if (!info.isDirectory())
        throw new Error(`${label} must be an existing directory.`);
}

export async function resolveVerifierPaths(paths) {
    const selected = {
        release: await canonicalPath(paths.release),
        evidence: await canonicalPath(paths.evidence),
        testRoot: await canonicalPath(paths.testRoot),
    };
    for (const [label, path] of Object.entries(selected))
        if (isCloudPath(path))
            throw new Error(`${label} resolves inside cloud-synced storage.`);
    if (contains(selected.release, selected.evidence) || contains(selected.evidence, selected.release))
        throw new Error('release and evidence paths must not overlap.');
    if (contains(selected.release, selected.testRoot))
        throw new Error('release and test-root paths must not overlap in a writable direction.');
    if (contains(selected.evidence, selected.testRoot))
        throw new Error('evidence and test-root paths must not overlap in a writable direction.');
    await requireDirectory(selected.release, 'release');
    await requireDirectory(selected.testRoot, 'test-root');
    validateUnixHandoffPath(selected.testRoot);
    try {
        const evidenceInfo = await stat(selected.evidence);
        if (!evidenceInfo.isDirectory())
            throw new Error('evidence must be a directory or a path that does not exist.');
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    return selected;
}

const SAFE_VERSION = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

export function studyHomeForRelease(osHome, release, platform = process.platform) {
    const version = release?.course_version;
    if (typeof version !== 'string' || version.length > 64 || !SAFE_VERSION.test(version))
        throw new Error('The release has a missing or unsafe course version.');
    if (platform === 'darwin')
        return join(osHome, `Library/Application Support/CourseWeave/Agent Harness Path v${version}`);
    return join(osHome, `.local/share/courseweave/agent-harness-path-v${version}`);
}

export function providerModeArguments({ synthetic = false, noProvider = false, providerEnvironment } = {}) {
    const selected = [synthetic, noProvider, Boolean(providerEnvironment)].filter(Boolean).length;
    if (selected > 1)
        throw new Error('Launcher provider modes are mutually exclusive.');
    if (synthetic || providerEnvironment)
        return ['--provider-env'];
    if (noProvider)
        return ['--no-provider'];
    return [];
}

const PROVIDER_LIMITS = [
    'COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS',
    'COURSEWEAVE_PROVIDER_RUN_TIMEOUT_SECONDS',
    'COURSEWEAVE_PROVIDER_MAX_OUTPUT_TOKENS',
];

export function liveProviderConfiguration(source) {
    const provider = source.COURSEWEAVE_PROVIDER;
    if (provider !== 'openai' && provider !== 'anthropic')
        throw new Error('Live acceptance requires COURSEWEAVE_PROVIDER=openai or anthropic.');
    const prefix = provider.toUpperCase();
    const modelName = `${prefix}_MODEL`;
    const keyName = `${prefix}_API_KEY`;
    const model = source[modelName]?.trim();
    const credential = source[keyName]?.trim();
    if (!model)
        throw new Error(`Live acceptance requires ${modelName}.`);
    if (!credential)
        throw new Error(`Live acceptance requires ${keyName}.`);
    const environment = {
        COURSEWEAVE_PROVIDER: provider,
        COURSEWEAVE_PROVIDER_PROFILE: 'text-only-v1',
        [modelName]: model,
        [keyName]: credential,
    };
    const baseName = `${prefix}_BASE_URL`;
    if (source[baseName]?.trim())
        environment[baseName] = source[baseName].trim();
    for (const name of PROVIDER_LIMITS)
        if (source[name] !== undefined)
            environment[name] = source[name];
    return { environment, credential };
}
