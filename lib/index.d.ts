import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-safe-workflow";
export declare const inject: string[];
export interface SafeWorkflowConfig {
    stateDirName?: string;
    approvalMode?: 'ask' | 'allow' | 'deny';
    autoCheckpoint?: boolean;
    mutatingTools?: string[];
}
export declare function apply(ctx: Context, rawConfig?: SafeWorkflowConfig): void;
//# sourceMappingURL=index.d.ts.map