export function workflowActionReferences(source: string): string[];

export function validateGitHubWorkflow(source: string, file?: string): string[];

export function checkGitHubActions(root?: string): Promise<{
  workflowCount: number;
  actionCount: number;
  violations: string[];
}>;
