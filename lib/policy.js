import { isAbsolute, relative, resolve } from 'node:path';
function normaliseRoot(root) {
    return resolve(root);
}
function matchesRule(root, candidate, rule) {
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    const pattern = rule.replaceAll('\\', '/').replace(/^\.\//, '');
    const rel = relative(root, absolute).replaceAll('\\', '/');
    if (pattern.endsWith('/**'))
        return rel === pattern.slice(0, -3) || rel.startsWith(`${pattern.slice(0, -3)}/`);
    if (pattern.includes('*')) {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
        return new RegExp(`^${escaped}$`).test(rel);
    }
    return rel === pattern || rel.startsWith(`${pattern}/`);
}
export function decidePath(rootDir, candidate, contract) {
    const root = normaliseRoot(rootDir);
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    const outside = relative(root, absolute).startsWith('..') || isAbsolute(relative(root, absolute));
    if (outside)
        return { allowed: false, reason: `path is outside the workspace: ${candidate}` };
    if (contract.forbiddenPaths.some(rule => matchesRule(root, absolute, rule))) {
        return { allowed: false, reason: `path matches a forbidden rule: ${candidate}` };
    }
    if (contract.allowedPaths.length > 0 && !contract.allowedPaths.some(rule => matchesRule(root, absolute, rule))) {
        return { allowed: false, reason: `path is not in allowedPaths: ${candidate}` };
    }
    return { allowed: true };
}
export function extractCandidatePaths(toolName, args) {
    const values = [];
    for (const key of ['path', 'file', 'filename', 'cwd']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim() !== '')
            values.push(value);
    }
    if (toolName === 'str_replace_editor' && typeof args.path === 'string')
        values.push(args.path);
    return [...new Set(values)];
}
export function isMutatingTool(toolName, configured) {
    if (configured.includes(toolName))
        return true;
    return /^(bash|pwsh|shell|write|edit|delete|move|copy|rename|mkdir|fs_write|fs_edit|str_replace_editor)$/i.test(toolName);
}
export function shouldAsk(toolName, contract, approvalMode) {
    if (approvalMode === 'allow')
        return false;
    if (approvalMode === 'deny')
        return true;
    return contract.requireApprovalFor.length === 0 || contract.requireApprovalFor.includes(toolName);
}
export function createContract(input, now = new Date()) {
    const stamp = now.toISOString();
    return {
        id: `wf-${stamp.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
        title: input.title,
        goal: input.goal,
        acceptance: input.acceptance ?? [],
        allowedPaths: input.allowedPaths ?? [],
        forbiddenPaths: input.forbiddenPaths ?? ['.env', '.env.*', '.git/**', 'node_modules/**'],
        requireApprovalFor: input.requireApprovalFor ?? [],
        status: 'active',
        createdAt: stamp,
        updatedAt: stamp,
        checkpoints: [],
        verifications: [],
    };
}
//# sourceMappingURL=policy.js.map