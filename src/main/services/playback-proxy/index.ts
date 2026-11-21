import { app, dialog, net, safeStorage, session, type BrowserWindow, type ProxyConfig, type Session } from "electron";
import Conf from "conf";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { PlaybackProxyState, ProxyNodeStatus } from "~shared/playback-proxy";
import { isObject, readSubscription, readXrayExport, type ProxyNode } from "./nodes";
import { probePlayback } from "./probe";
import { runXray, type RunningXray } from "./xray";

interface SavedSettings {
  executable: string | null;
  activeNodeId: string | null;
  enabled: boolean | null;
  protectedData: string | null;
}

interface PrivateData {
  subscription: string | null;
  nodes: ProxyNode[];
  skippedNodes: number;
}

class ProxySettingsError extends Error {}

const systemProxy: ProxyConfig = { mode: "system" };
const unavailableProxy: ProxyConfig = { mode: "fixed_servers", proxyRules: "socks5://proxy-unavailable.invalid:1" };
const maxSubscriptionBytes = 4 * 1024 * 1024;

export default class PlaybackProxy {
  private readonly store = new Conf<SavedSettings>({
    configName: "playback-proxy",
    cwd: app.getPath("userData"),
    defaults: { executable: null, activeNodeId: null, enabled: null, protectedData: null },
  });

  private readonly children = new Set<ChildProcess>();
  private readonly closing = new AbortController();
  private readonly results = new Map<string, Omit<ProxyNodeStatus, "id" | "name">>();
  private data: PrivateData = { subscription: null, nodes: [], skippedNodes: 0 };
  private executable = this.store.get("executable");
  private selectedNodeId = this.store.get("activeNodeId");
  // Earlier versions activated a saved node as soon as it was selected.
  private enabled = this.store.get("enabled") ?? (this.selectedNodeId !== null);
  private activeXray?: RunningXray;
  private route = systemProxy;
  private canSaveNodes = false;
  private connectionError: string | null = null;
  private activity: PlaybackProxyState["activity"] = null;
  private testRun?: AbortController;

  constructor(
    private readonly playerSession: Session,
    private readonly onChanged: (state: PlaybackProxyState) => void,
    private readonly reloadPlayer: () => void,
  ) {}

  public get connected() {
    return this.activeXray !== undefined;
  }

  public getState(): PlaybackProxyState {
    return {
      executable: this.executable,
      hasSubscription: this.data.subscription !== null,
      canSaveNodes: this.canSaveNodes,
      enabled: this.enabled,
      selectedNodeId: this.selectedNodeId,
      connectionError: this.connectionError,
      activity: this.activity,
      testing: this.testRun !== undefined,
      skippedNodes: this.data.skippedNodes,
      nodes: this.data.nodes.map(({ id, name }) => ({
        id,
        name,
        status: "untested",
        ...this.results.get(id),
      })),
    };
  }

  public async initialize() {
    this.activity = "configuring";
    try {
      try {
        this.canSaveNodes = await safeStorage.isAsyncEncryptionAvailable();
        const stored = this.store.get("protectedData");
        if (stored) {
          if (!this.canSaveNodes) throw new Error();
          const decrypted = await safeStorage.decryptStringAsync(Buffer.from(stored, "base64"));
          this.data = JSON.parse(decrypted.result);
        }
      } catch {
        this.connectionError = "Saved proxy settings could not be opened.";
      }

      if (this.enabled) {
        try {
          const node = this.data.nodes.find(candidate => candidate.id === this.selectedNodeId);
          if (!node || !this.executable) throw new Error();
          await this.connect(node, this.executable);
        } catch {
          this.connectionError ??= "The saved node could not start. Reconnect or choose a different node in Settings.";
          await this.playerSession.setProxy(unavailableProxy);
          this.route = unavailableProxy;
        }
      }
    } finally {
      this.activity = null;
      this.publish();
    }
  }

  public stop() {
    this.closing.abort();
    for (const child of this.children) child.kill();
  }

  public async chooseExecutable(parent: BrowserWindow) {
    return this.perform("configuring", async () => {
      const selection = await dialog.showOpenDialog(parent, {
        title: "Choose the Xray executable",
        defaultPath: this.executable ?? undefined,
        properties: ["openFile"],
        filters: process.platform === "win32" ? [{ name: "Executable", extensions: ["exe"] }] : undefined,
      });
      if (selection.canceled) return;
      const executable = selection.filePaths[0];
      const selected = this.data.nodes.find(node => node.id === this.selectedNodeId);
      if (this.enabled && selected) {
        await this.connect(selected, executable, () => this.store.set("executable", executable));
        this.reloadPlayer();
      } else {
        this.store.set("executable", executable);
      }
      this.executable = executable;
      if (this.data.nodes.length) this.startTests();
    });
  }

  public async importNodes(parent: BrowserWindow) {
    return this.perform("configuring", async () => {
      const selection = await dialog.showOpenDialog(parent, {
        title: "Import v2rayN client configurations",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Xray JSON", extensions: ["json"] }],
      });
      if (selection.canceled) return;

      const nodes = new Map(this.data.nodes.map(node => [node.id, node]));
      for (const file of selection.filePaths) {
        try {
          const config = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
          const node = readXrayExport(config, basename(file, ".json"));
          if (!node) throw new Error();
          nodes.set(node.id, node);
        } catch {
          throw new ProxySettingsError("Each imported JSON file must contain a single standalone VLESS outbound.");
        }
      }
      await this.saveData({ ...this.data, nodes: [...nodes.values()] });
    });
  }

  public async fetchSubscription(input: unknown) {
    return this.perform("downloading", async () => {
      if (typeof input !== "string") throw new ProxySettingsError("Enter a subscription URL.");
      const address = input.trim() || this.data.subscription;
      let subscription: URL;
      try {
        subscription = new URL(address ?? "");
        if (subscription.protocol !== "https:" && subscription.protocol !== "http:") throw new Error();
      } catch {
        throw new ProxySettingsError("Enter a valid HTTP or HTTPS subscription URL.");
      }
      if (subscription.href !== this.data.subscription) {
        await this.saveData({ ...this.data, subscription: subscription.href });
      }
      const body = await this.download(subscription);
      const { nodes, skipped } = readSubscription(body);
      if (!nodes.length) {
        throw new ProxySettingsError("No supported VLESS nodes were found. Use your provider’s v2rayN subscription URL.");
      }

      const updated = new Map(nodes.map(node => [node.id, node]));
      const selected = this.data.nodes.find(node => node.id === this.selectedNodeId);
      for (const node of this.data.nodes) {
        if (node.source === "file") updated.set(node.id, node);
      }
      if (selected && !updated.has(selected.id)) updated.set(selected.id, { ...selected, source: "retained" });
      await this.saveData({ subscription: subscription.href, nodes: [...updated.values()], skippedNodes: skipped });
      this.results.clear();
      if (this.executable) this.startTests();
    });
  }

  public async setEnabled(enabled: unknown) {
    return this.perform("configuring", async () => {
      if (typeof enabled !== "boolean") throw new ProxySettingsError("Choose whether to enable the playback proxy.");
      if (enabled === this.enabled) return;
      const node = enabled ? this.data.nodes.find(candidate => candidate.id === this.selectedNodeId) : undefined;
      if (enabled && !node) throw new ProxySettingsError("Select a node before enabling the playback proxy.");
      await this.connect(node, this.executable, () => this.store.set("enabled", this.canSaveNodes && enabled));
      this.enabled = enabled;
      this.reloadPlayer();
    }, { allowDuringTests: true });
  }

  public async selectNode(id: unknown) {
    return this.perform("configuring", async () => {
      const node = this.data.nodes.find(candidate => candidate.id === id);
      if (!node) throw new ProxySettingsError("Choose a node from the list.");
      const saveSelection = () => {
        this.store.store = {
          ...this.store.store,
          activeNodeId: this.canSaveNodes ? node.id : null,
          enabled: this.canSaveNodes && this.enabled,
        };
      };
      if (this.enabled) {
        await this.connect(node, this.executable, saveSelection);
        this.reloadPlayer();
      } else {
        saveSelection();
      }
      this.selectedNodeId = node.id;
    }, { allowDuringTests: true });
  }

  public async removeNode(id: unknown) {
    return this.perform("configuring", async () => {
      const next = { ...this.data, nodes: this.data.nodes.filter(node => node.id !== id) };
      if (next.nodes.length === this.data.nodes.length) return;
      const removingSelectedNode = this.selectedNodeId === id;
      if (removingSelectedNode && this.enabled) {
        throw new ProxySettingsError("Select another node or turn off the proxy before removing the active node.");
      }
      await this.saveData(next, removingSelectedNode ? null : this.selectedNodeId);
      this.results.delete(id as string);
    });
  }

  public async testNodes() {
    return this.perform("configuring", async () => this.startTests());
  }

  public cancelTests() {
    this.testRun?.abort();
  }

  private publish() {
    if (!this.closing.signal.aborted) this.onChanged(this.getState());
  }

  private async perform(
    activity: NonNullable<PlaybackProxyState["activity"]>,
    work: () => Promise<void>,
    { allowDuringTests = false } = {},
  ) {
    if (this.activity) throw new ProxySettingsError("A proxy operation is already in progress.");
    if (this.testRun && !allowDuringTests) throw new ProxySettingsError("Stop the current node tests before editing the node list or Xray executable.");
    this.activity = activity;
    this.publish();
    try {
      await work();
    } catch (error) {
      if (error instanceof ProxySettingsError) throw error;
      // Errors from networking, process launch, and storage can include the subscription URL or credentials.
      throw new ProxySettingsError("The proxy operation could not be completed.");
    } finally {
      this.activity = null;
      this.publish();
    }
  }

  private async download(url: URL): Promise<string> {
    try {
      const response = await net.fetch(url.href, {
        headers: { "User-Agent": "v2rayN" },
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([this.closing.signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ProxySettingsError(`The subscription server returned HTTP ${response.status}.`);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return Buffer.concat(chunks).toString("utf8");
        length += chunk.value.byteLength;
        if (length > maxSubscriptionBytes) {
          await reader.cancel();
          throw new ProxySettingsError("The subscription exceeds 4 MB.");
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof ProxySettingsError) throw error;
      throw new ProxySettingsError("The subscription could not be downloaded. Check the URL and connection.");
    }
  }

  private async saveData(data: PrivateData, selectedNodeId = this.selectedNodeId) {
    if (this.canSaveNodes) {
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(data));
      this.store.store = { ...this.store.store, protectedData: encrypted.toString("base64"), activeNodeId: selectedNodeId };
    }
    this.data = data;
    this.selectedNodeId = selectedNodeId;
  }

  private async connect(node: ProxyNode | undefined, executable: string | null, commit?: () => void) {
    let next: RunningXray | undefined;
    if (node) {
      if (!executable) throw new ProxySettingsError("Choose an Xray executable first.");
      try {
        next = await runXray(executable, node.outbound, this.children, this.closing.signal);
      } catch {
        throw new ProxySettingsError("Xray could not start this node. Check the executable and node.");
      }
    }
    const route: ProxyConfig = next ? { mode: "fixed_servers", proxyRules: next.proxyRules } : systemProxy;
    try {
      await this.playerSession.setProxy(route);
      await this.playerSession.closeAllConnections();
      commit?.();
    } catch (error) {
      next?.child.kill();
      await this.playerSession.setProxy(this.route);
      await this.playerSession.closeAllConnections();
      throw error;
    }

    const previous = this.activeXray;
    this.activeXray = next;
    this.route = route;
    this.connectionError = null;
    previous?.child.kill();
    next?.child.once("close", () => {
      if (this.activeXray !== next) return;
      this.activeXray = undefined;
      this.connectionError = "Xray stopped. Reconnect or choose another node.";
      this.publish();
    });
  }

  private startTests() {
    const executable = this.executable;
    if (!executable) throw new ProxySettingsError("Choose an Xray executable to test the nodes.");
    this.testRun = new AbortController();
    const signal = AbortSignal.any([this.closing.signal, this.testRun.signal]);
    this.results.clear();
    this.publish();
    void this.testAll(executable, signal).finally(() => {
      this.testRun = undefined;
      this.publish();
    });
  }

  private async testAll(executable: string, signal: AbortSignal) {
    const nodes = this.data.nodes.values();

    const worker = async (index: number) => {
      const network = session.fromPartition(`ytm-proxy-probe-${index}`, { cache: false });
      for (const node of nodes) {
        if (signal.aborted) break;
        this.results.set(node.id, { status: "testing" });
        this.publish();
        let process: RunningXray | undefined;
        try {
          process = await runXray(executable, node.outbound, this.children, signal);
          await network.clearStorageData();
          await network.setProxy({ mode: "fixed_servers", proxyRules: process.proxyRules });
          const outcome = await probePlayback(network, signal);
          this.results.set(node.id, outcome);
        } catch {
          this.results.set(node.id, { status: signal.aborted ? "untested" : process ? "unreachable" : "core-error" });
        } finally {
          process?.child.kill();
          await network.closeAllConnections().catch(() => {});
          this.publish();
        }
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(3, this.data.nodes.length) }, (_, index) => worker(index)));
  }
}
