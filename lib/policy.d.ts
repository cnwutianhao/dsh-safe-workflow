export interface WorkflowContract {
    id: string;
    title: string;
    goal: string;
    acceptance: string[];
    allowedPaths: string[];
    forbiddenPaths: string[];
    requireApprovalFor: string[];
    status: 'active' | 'passed' | 'failed' | 'closed';
    createdAt: string;
    updatedAt: string;
    checkpoints: string[];
    verifications: VerificationRecord[];
}
export interface VerificationRecord {
    command: string;
    exitCode: number;
    output: string;
    passed: boolean;
    at: string;
}
export interface PathDecision {
    allowed: boolean;
    reason?: string;
}
export declare function decidePath(rootDir: string, candidate: string, contract: WorkflowContract): PathDecision;
export declare function extractCandidatePaths(toolName: string, args: Record<string, unknown>): string[];
export declare function isMutatingTool(toolName: string, configured: readonly string[]): boolean;
export declare function shouldAsk(toolName: string, contract: WorkflowContract, approvalMode: 'ask' | 'allow' | 'deny'): boolean;
export declare function createContract(input: {
    title: string;
    goal: string;
    acceptance?: string[];
    allowedPaths?: string[];
    forbiddenPaths?: string[];
    requireApprovalFor?: string[];
}, now?: Date): WorkflowContract;
//# sourceMappingURL=policy.d.ts.map