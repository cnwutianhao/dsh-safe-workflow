import { appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createContract, decidePath, extractCandidatePaths, isMutatingTool, shouldAsk, } from './policy.js';
export const name = 'dsh-safe-workflow';
export const inject = ['tools'];
const ACTIONS = ['start', 'status', 'checkpoint', 'verify', 'close', 'restore'];
function textResult(value) {
    return {
        schema: { type: 'json' },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
}
function workspaceOf(exec) {
    return resolve(exec.agent?.session.header.cwd ?? process.cwd());
}
async function readJson(path, fallback) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return fallback;
    }
}
async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function audit(stateDir, record) {
    await mkdir(stateDir, { recursive: true });
    await appendFile(join(stateDir, 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
}
async function filesUnder(root, directory, stateDir) {
    const results = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(directory, entry.name);
        const rel = relative(root, path).replaceAll('\\', '/');
        if (rel === '.git' || rel.startsWith('.git/') || rel === 'node_modules' || rel.startsWith('node_modules/')
            || rel === relative(root, stateDir).replaceAll('\\', '/')
            || rel.startsWith(`${relative(root, stateDir).replaceAll('\\', '/')}/`))
            continue;
        if (entry.isDirectory())
            results.push(...await filesUnder(root, path, stateDir));
        else if (entry.isFile())
            results.push(path);
    }
    return results;
}
async function snapshot(root, stateDir, label, paths) {
    const id = `cp-${Date.now().toString(36)}`;
    const filesDir = join(stateDir, 'checkpoints', id, 'files');
    await mkdir(filesDir, { recursive: true });
    const requested = [...new Set(paths.map(path => resolve(root, path)))];
    const expanded = [];
    for (const path of requested) {
        if (existsSync(path) && (await stat(path)).isDirectory())
            expanded.push(...await filesUnder(root, path, stateDir));
        else
            expanded.push(path);
    }
    const unique = [...new Set(expanded)];
    const entries = [];
    for (const path of unique) {
        const exists = existsSync(path);
        const rel = relative(root, path);
        if (rel.startsWith('..'))
            throw new Error(`checkpoint path is outside workspace: ${rel}`);
        const file = exists ? join(filesDir, Buffer.from(rel).toString('base64url')) : undefined;
        if (exists && file !== undefined)
            await copyFile(path, file);
        entries.push({ path: rel, exists, ...(file === undefined ? {} : { file: relative(stateDir, file) }) });
    }
    const checkpoint = { id, label, createdAt: new Date().toISOString(), entries };
    await writeJson(join(stateDir, 'checkpoints', id, 'manifest.json'), checkpoint);
    await audit(stateDir, { kind: 'checkpoint', id, label, paths: entries.map(entry => entry.path) });
    return checkpoint;
}
async function restore(root, stateDir, id) {
    const checkpoint = await readJson(join(stateDir, 'checkpoints', id, 'manifest.json'), null);
    if (checkpoint === null)
        throw new Error(`checkpoint not found: ${id}`);
    for (const entry of checkpoint.entries) {
        const target = resolve(root, entry.path);
        if (!entry.exists) {
            await rm(target, { force: true, recursive: true });
            continue;
        }
        if (entry.file === undefined)
            throw new Error(`checkpoint entry has no snapshot file: ${entry.path}`);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(stateDir, entry.file), target);
    }
    await audit(stateDir, { kind: 'restore', id, paths: checkpoint.entries.map(entry => entry.path) });
    return checkpoint;
}
function command(command, cwd, signal, timeoutMs = 120_000) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn('/bin/sh', ['-lc', command], { cwd, signal });
        let output = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stderr.on('data', chunk => { output += String(chunk); });
        child.once('error', reject);
        child.once('close', code => { clearTimeout(timer); resolvePromise({ exitCode: code ?? 1, output: output.slice(-20_000) }); });
    });
}
function pathsFromTool(toolName, args, root) {
    const candidates = extractCandidatePaths(toolName, args);
    if (candidates.length > 0)
        return candidates;
    if (toolName === 'bash' || toolName === 'pwsh' || toolName === 'shell')
        return ['.'];
    return [root];
}
export function apply(ctx, rawConfig = {}) {
    const config = {
        stateDirName: rawConfig.stateDirName ?? '.dsh-safe-workflow',
        approvalMode: rawConfig.approvalMode ?? 'ask',
        autoCheckpoint: rawConfig.autoCheckpoint ?? true,
        mutatingTools: rawConfig.mutatingTools ?? [],
    };
    const contracts = new Map();
    const workflowTool = defineTool({
        name: 'safe_workflow',
        description: 'Create and manage a task contract, checkpoints, verification evidence, and best-effort rollback for the current workspace.',
        parameters: {
            action: { type: 'string', required: true, enum: [...ACTIONS], description: 'The workflow operation.' },
            title: { type: 'string', description: 'Short task title for start.' },
            goal: { type: 'string', description: 'Concrete task goal for start.' },
            acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance checks for start.' },
            allowedPaths: { type: 'array', items: { type: 'string' }, description: 'Optional workspace-relative allowlist.' },
            forbiddenPaths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative deny rules.' },
            requireApprovalFor: { type: 'array', items: { type: 'string' }, description: 'Tool names that require human approval.' },
            label: { type: 'string', description: 'Checkpoint label.' },
            checkpointId: { type: 'string', description: 'Checkpoint id for restore.' },
            command: { type: 'string', description: 'Verification command.' },
        },
        output: textResult({}),
        async execute(args, exec) {
            const root = workspaceOf(exec);
            const stateDir = join(root, config.stateDirName);
            const key = String(exec.agent?.id ?? root);
            const contractPath = join(stateDir, 'contract.json');
            let contract = contracts.get(key) ?? await readJson(contractPath, null);
            const action = String(args.action);
            if (!ACTIONS.includes(action))
                throw new Error(`unknown safe_workflow action: ${action}`);
            if (action === 'start') {
                if (typeof args.title !== 'string' || typeof args.goal !== 'string')
                    throw new Error('start requires title and goal');
                contract = createContract({
                    title: args.title,
                    goal: args.goal,
                    acceptance: Array.isArray(args.acceptance) ? args.acceptance.filter((item) => typeof item === 'string') : undefined,
                    allowedPaths: Array.isArray(args.allowedPaths) ? args.allowedPaths.filter((item) => typeof item === 'string') : undefined,
                    forbiddenPaths: Array.isArray(args.forbiddenPaths) ? args.forbiddenPaths.filter((item) => typeof item === 'string') : undefined,
                    requireApprovalFor: Array.isArray(args.requireApprovalFor) ? args.requireApprovalFor.filter((item) => typeof item === 'string') : undefined,
                });
                contracts.set(key, contract);
                await writeJson(contractPath, contract);
                await audit(stateDir, { kind: 'contract/start', id: contract.id, title: contract.title });
                return JSON.parse(JSON.stringify({ action, contract }));
            }
            if (contract === null)
                throw new Error('no active workflow contract; call safe_workflow start first');
            if (action === 'status')
                return JSON.parse(JSON.stringify({ action, contract }));
            if (action === 'checkpoint') {
                const checkpoint = await snapshot(root, stateDir, typeof args.label === 'string' ? args.label : 'manual', ['.']);
                contract.checkpoints.push(checkpoint.id);
                contract.updatedAt = new Date().toISOString();
                await writeJson(contractPath, contract);
                return JSON.parse(JSON.stringify({ action, checkpoint }));
            }
            if (action === 'restore') {
                if (typeof args.checkpointId !== 'string')
                    throw new Error('restore requires checkpointId');
                const checkpoint = await restore(root, stateDir, args.checkpointId);
                return JSON.parse(JSON.stringify({ action, checkpoint }));
            }
            if (action === 'verify') {
                if (typeof args.command !== 'string' || args.command.trim() === '')
                    throw new Error('verify requires command');
                const result = await command(args.command, root, exec.signal);
                const record = { command: args.command, ...result, passed: result.exitCode === 0, at: new Date().toISOString() };
                contract.verifications.push(record);
                contract.status = record.passed ? 'passed' : 'failed';
                contract.updatedAt = record.at;
                await writeJson(contractPath, contract);
                await audit(stateDir, { kind: 'verification', ...record });
                return JSON.parse(JSON.stringify({ action, verification: record }));
            }
            contract.status = 'closed';
            contract.updatedAt = new Date().toISOString();
            await writeJson(contractPath, contract);
            await audit(stateDir, { kind: 'contract/close', id: contract.id });
            return JSON.parse(JSON.stringify({ action, contract }));
        },
    });
    ctx.tools.register(workflowTool);
    ctx.on('tools/pre-execute', async (exec, next) => {
        const root = workspaceOf(exec);
        const contract = contracts.get(String(exec.agent?.id ?? root)) ?? await readJson(join(root, config.stateDirName, 'contract.json'), null);
        if (contract === null || !isMutatingTool(exec.name, config.mutatingTools))
            return next();
        const args = (exec.arguments ?? {});
        for (const path of extractCandidatePaths(exec.name, args)) {
            const decision = decidePath(root, path, contract);
            if (!decision.allowed)
                return { kind: 'deny', reason: decision.reason ?? 'workflow path policy denied this call' };
        }
        if (shouldAsk(exec.name, contract, config.approvalMode)) {
            return { kind: 'ask', reason: `safe-workflow approval required before ${exec.name}` };
        }
        return next();
    });
    ctx.on('tools/execute', async (exec, next) => {
        if (!config.autoCheckpoint || exec.name === 'safe_workflow' || !isMutatingTool(exec.name, config.mutatingTools))
            return next();
        const root = workspaceOf(exec);
        const contract = contracts.get(String(exec.agent?.id ?? root)) ?? await readJson(join(root, config.stateDirName, 'contract.json'), null);
        if (contract === null)
            return next();
        const stateDir = join(root, config.stateDirName);
        const paths = pathsFromTool(exec.name, (exec.arguments ?? {}), root);
        const checkpoint = await snapshot(root, stateDir, `before ${exec.name}`, paths);
        contract.checkpoints.push(checkpoint.id);
        contract.updatedAt = new Date().toISOString();
        await writeJson(join(stateDir, 'contract.json'), contract);
        return next();
    });
    ctx.on('session/event', (session, event) => {
        const root = session.header.cwd;
        if (root === undefined)
            return;
        void audit(join(root, config.stateDirName), { kind: 'session/event', session: String(session.id), event: event.type, seq: event.seq });
    });
}
//# sourceMappingURL=index.js.map