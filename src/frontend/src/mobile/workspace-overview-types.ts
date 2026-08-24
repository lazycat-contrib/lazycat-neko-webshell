import type { SessionBackendId } from "../types.ts";

export type MobileWorkspaceOverviewPane = {
  id: string;
  label: string;
  detail: string;
  backend: SessionBackendId;
  active: boolean;
};

export type MobileWorkspaceOverviewTab = {
  id: string;
  label: string;
  detail: string;
  active: boolean;
  panes: MobileWorkspaceOverviewPane[];
};

export type MobileWorkspaceOverviewLabels = {
  empty: string;
  active: string;
};
