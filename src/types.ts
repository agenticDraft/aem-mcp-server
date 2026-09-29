export type CliParams = {
  host?: string;
  user?: string;
  pass?: string;
  id?: string;
  secret?: string;
  mcpPort?: number;
  /** Interface the http transport binds to. Defaults to loopback: /mcp has no auth. */
  mcpHost?: string;
  /** Comma-separated extra origins for the http transport; loopback is always allowed. */
  allowedOrigins?: string;
  transport?: 'http' | 'stdio';
  instances?: string;
  cert?: string;
  key?: string;
  ca?: string;
};

export type InstanceConfig = {
  name: string;
  host: string;
  user: string;
  pass: string;
  id?: string;
  secret?: string;
};
