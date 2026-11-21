export type ProxyTestStatus =
  | "untested"
  | "testing"
  | "playable"
  | "reachable"
  | "sign-in"
  | "verification"
  | "consent"
  | "unavailable"
  | "unreachable"
  | "core-error";

export interface ProxyNodeStatus {
  id: string;
  name: string;
  status: ProxyTestStatus;
  loadTime?: number;
}

export interface PlaybackProxyState {
  executable: string | null;
  hasSubscription: boolean;
  canSaveNodes: boolean;
  enabled: boolean;
  selectedNodeId: string | null;
  connectionError: string | null;
  activity: "configuring" | "downloading" | null;
  testing: boolean;
  skippedNodes: number;
  nodes: ProxyNodeStatus[];
}

export interface PlaybackProxySettings {
  getState(): Promise<PlaybackProxyState>;
  chooseExecutable(): Promise<void>;
  importNodes(): Promise<void>;
  fetchSubscription(url: string): Promise<void>;
  testNodes(): Promise<void>;
  cancelTests(): void;
  setEnabled(enabled: boolean): Promise<void>;
  selectNode(id: string): Promise<void>;
  removeNode(id: string): Promise<void>;
  onChanged(callback: (state: PlaybackProxyState) => void): () => void;
}
