export type PublicTunnelInfo = {
  id: string;
  provider: string;
  publicUrl: string;
  upstreamUrl: string;
  status: string;
  createdAtMs: number;
};

export type TunnelProviderProfileSummary = {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  lastUsedAtMs: number;
};

export type TunnelProviderProfileEditor = {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  authtoken: string;
};
