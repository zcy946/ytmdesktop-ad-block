<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { PlaybackProxyState, ProxyTestStatus } from "~shared/playback-proxy";

const api = window.ytmd.playbackProxy;
const state = ref<PlaybackProxyState>();
const subscriptionUrl = ref("");
const pending = ref(false);
const error = ref("");
const busy = computed(() => pending.value || Boolean(state.value?.activity));
const listBusy = computed(() => busy.value || Boolean(state.value?.testing));
const selected = computed(() => state.value?.nodes.find(node => node.id === state.value?.selectedNodeId));
const canEnable = computed(() => Boolean(state.value?.executable && selected.value));
const nodes = computed(() => {
  const list = state.value?.nodes ?? [];
  if (state.value?.testing) return list;
  return list.toSorted((a, b) => Number(b.status === "playable") - Number(a.status === "playable"));
});
const testedCount = computed(() => nodes.value.filter(node => node.status !== "untested" && node.status !== "testing").length);
const statusLabels: Record<ProxyTestStatus, string> = {
  untested: "Not tested",
  testing: "Testing…",
  playable: "Sample played",
  reachable: "Page loaded",
  "sign-in": "Sign-in required",
  verification: "Human verification",
  consent: "Consent required",
  unavailable: "Music unavailable",
  unreachable: "Connection failed",
  "core-error": "Xray start failed",
};

let unsubscribe: (() => void) | undefined;
onMounted(async () => {
  unsubscribe = api.onChanged(value => { state.value = value; });
  try {
    state.value = await api.getState();
  } catch {
    error.value = "Could not load proxy settings.";
  }
});
onUnmounted(() => unsubscribe?.());

async function run(action: () => Promise<void>) {
  if (busy.value) return;
  pending.value = true;
  error.value = "";
  try {
    await action();
  } catch (failure) {
    error.value = String(failure).replace(/^Error: Error invoking remote method '[^']+': (?:Error: )?/, "");
  } finally {
    pending.value = false;
  }
}

function updateSubscription() {
  return run(async () => {
    await api.fetchSubscription(subscriptionUrl.value);
    subscriptionUrl.value = "";
  });
}

function toggleProxy() {
  const enabled = !state.value?.enabled;
  return run(() => api.setEnabled(enabled));
}

function reconnect() {
  const node = selected.value;
  if (node) return run(() => api.selectNode(node.id));
}
</script>

<template>
  <section class="proxy-settings">
    <h2>Playback proxy</h2>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="state">
      <div class="section">
        <div class="toggle-row">
          <span id="proxy-enabled-label">Enable playback proxy</span>
          <button
            type="button"
            class="proxy-switch"
            role="switch"
            aria-labelledby="proxy-enabled-label"
            :aria-checked="state.enabled"
            :disabled="busy || (!state.enabled && !canEnable)"
            @click="toggleProxy"
          />
        </div>
        <div v-if="state.selectedNodeId" class="actions selected-node">
          <span class="node-status">{{ state.enabled ? "Active node" : "Selected node" }}</span>
          <strong class="node-name">{{ selected?.name ?? "Saved node" }}</strong>
          <button v-if="state.enabled && selected" type="button" :disabled="busy" @click="reconnect">Reconnect</button>
        </div>
        <p v-if="state.connectionError" class="error" role="alert">{{ state.connectionError }}</p>
        <p v-else-if="state.enabled" class="hint">Switching nodes reloads YouTube Music.</p>
        <p v-else-if="canEnable" class="hint">Playback uses the system proxy settings.</p>
        <p v-else class="hint">Choose Xray and select a node to enable the playback proxy.</p>
      </div>

      <div class="section">
        <div class="label">Xray executable</div>
        <div class="actions">
          <button type="button" :disabled="listBusy" @click="run(api.chooseExecutable)">Choose Xray…</button>
          <span class="path">{{ state.executable || "Select xray.exe or xray." }}</span>
        </div>
      </div>

      <form class="section" @submit.prevent="updateSubscription">
        <label for="subscription-url">Subscription URL</label>
        <div class="actions subscription">
          <input
            id="subscription-url"
            v-model="subscriptionUrl"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="state.hasSubscription ? 'Saved subscription URL' : 'Paste your v2rayN subscription URL'"
            :disabled="listBusy"
          >
          <button class="primary" type="submit" :disabled="listBusy || (!subscriptionUrl.trim() && !state.hasSubscription)">
            {{ state.hasSubscription && !subscriptionUrl.trim() ? "Refresh and test" : "Fetch and test" }}
          </button>
        </div>
        <p class="hint">Supports plain-text and Base64 VLESS subscriptions. Tests use a public song in a signed-out session.</p>
        <p v-if="!state.canSaveNodes" class="hint">System encryption is unavailable. The subscription URL and nodes last until you quit.</p>
      </form>

      <div class="section">
        <div class="actions">
          <button type="button" :disabled="listBusy" @click="run(api.importNodes)">Import v2rayN JSON…</button>
          <button
            v-if="state.testing"
            type="button"
            @click="api.cancelTests()"
          >Stop tests</button>
          <button v-else type="button" :disabled="busy || !state.executable || !nodes.length" @click="run(api.testNodes)">Test all nodes</button>
        </div>
        <p v-if="state.activity === 'downloading'" class="hint" role="status">Downloading subscription…</p>
        <p v-if="state.testing" class="hint" role="status">Tested {{ testedCount }} of {{ nodes.length }} nodes</p>
        <p v-if="state.skippedNodes" class="hint">{{ state.skippedNodes }} unsupported or invalid subscription entries skipped.</p>
        <p v-if="nodes.length && !state.executable" class="hint">Choose Xray to test and use the imported nodes.</p>
        <ul v-if="nodes.length" class="nodes" aria-label="Proxy nodes">
          <li v-for="node in nodes" :key="node.id" class="node">
            <div class="node-details">
              <div class="node-name" :title="node.name">{{ node.name }}</div>
              <div class="node-status" :class="{ playable: node.status === 'playable' }">
                {{ statusLabels[node.status] }}
                <span v-if="node.loadTime !== undefined"> · {{ (node.loadTime / 1000).toFixed(1) }} s to load</span>
              </div>
            </div>
            <button
              type="button"
              :disabled="busy || node.id === state.selectedNodeId"
              @click="run(() => api.selectNode(node.id))"
            >{{ node.id === state.selectedNodeId ? (state.enabled ? "Active" : "Selected") : (state.enabled ? "Use" : "Select") }}</button>
            <button
              type="button"
              :disabled="listBusy || (state.enabled && node.id === state.selectedNodeId)"
              :aria-label="'Remove ' + node.name"
              @click="run(() => api.removeNode(node.id))"
            >Remove</button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.proxy-settings {
  padding: 8px 0 16px;
}

h2 {
  margin: 4px 0 14px;
  font-size: 20px;
}

.section {
  padding: 12px 0;
  border-top: 1px solid #252525;
}

.label,
label {
  display: block;
  margin-bottom: 7px;
  font-weight: 600;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
}

button.proxy-switch {
  position: relative;
  flex: 0 0 52px;
  height: 28px;
  padding: 0;
  border-radius: 20px;
}

.proxy-switch::before {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #eee;
}

button.proxy-switch[aria-checked="true"] {
  border-color: #f44336;
  background: #f44336;
}

.proxy-switch[aria-checked="true"]::before {
  left: 27px;
}

.selected-node {
  margin-top: 8px;
}

.subscription input {
  flex: 1 1 215px;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 9px;
  border: 1px solid #3d3d3d;
  border-radius: 5px;
  background: #161616;
  color: #fff;
  font: inherit;
  user-select: text;
}

button {
  padding: 6px 10px;
  border: 1px solid #454545;
  border-radius: 5px;
  background: #252525;
  color: #eee;
  font: inherit;
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: #393939;
}

button.primary {
  border-color: #e1e1e1;
  background: #e1e1e1;
  color: #171717;
}

button.primary:hover:not(:disabled) {
  background: #fff;
}

button:disabled {
  opacity: 0.55;
  cursor: default;
}

.hint,
.error,
.node-status,
.path {
  font-size: 13px;
}

.hint,
.node-status,
.path {
  color: #aaa;
}

.hint,
.error {
  margin: 8px 0 0;
}

.error {
  color: #ffadad;
}

.path {
  min-width: 0;
  flex: 1 1 190px;
  overflow-wrap: anywhere;
}

.nodes {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #252525;
}

.node-details {
  flex: 1;
  min-width: 0;
}

.node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-status.playable {
  color: #a4dfb0;
}
</style>
