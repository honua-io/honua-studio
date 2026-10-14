export function bindOwnedDeployment(
  path: string,
  endpoint: string,
): Promise<{ identity: unknown; verify: () => Promise<unknown> }>;
