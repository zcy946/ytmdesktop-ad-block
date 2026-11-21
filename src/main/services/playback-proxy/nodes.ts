import { createHash } from "node:crypto";

export interface XrayOutbound {
  protocol: "vless";
  settings: Record<string, unknown>;
  streamSettings?: Record<string, unknown>;
  mux?: Record<string, unknown>;
}

export interface ProxyNode {
  id: string;
  name: string;
  source: "subscription" | "file" | "retained";
  outbound: XrayOutbound;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeNode(name: string, source: ProxyNode["source"], outbound: XrayOutbound): ProxyNode {
  return {
    id: createHash("sha256").update(JSON.stringify(outbound)).digest("hex"),
    name: name.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) || "VLESS node",
    source,
    outbound,
  };
}

export function readXrayExport(value: unknown, name: string): ProxyNode | undefined {
  if (!isObject(value) || !Array.isArray(value.outbounds)) return;

  const proxies = value.outbounds.filter(
    entry => isObject(entry) && !["freedom", "blackhole", "dns"].includes(String(entry.protocol)),
  );
  if (proxies.length !== 1) return;

  const { protocol, settings, streamSettings, mux, proxySettings } = proxies[0];
  if (protocol !== "vless" || !isObject(settings) || (isObject(proxySettings) && proxySettings.tag)) return;
  if (Array.isArray(settings.vnext) && settings.vnext.length !== 1) return;
  if (isObject(streamSettings) && isObject(streamSettings.sockopt) && streamSettings.sockopt.dialerProxy) return;

  return makeNode(name, "file", {
    protocol,
    settings,
    streamSettings: isObject(streamSettings) ? streamSettings : undefined,
    mux: isObject(mux) ? mux : undefined,
  });
}

function parseVlessLink(link: string): ProxyNode | undefined {
  const uri = new URL(link);
  if (uri.protocol !== "vless:" || !uri.username || uri.password || !uri.hostname || !uri.port || Number(uri.port) < 1) return;
  const host = uri.hostname.replace(/^\[|\]$/g, "");
  const parameter = (name: string) => uri.searchParams.get(name) ?? undefined;
  const security = parameter("security") ?? "none";
  const network = parameter("type") ?? "tcp";
  const streamSettings: Record<string, unknown> = { network: network === "tcp" ? "raw" : network, security };

  const transportHost = parameter("host");
  const path = parameter("path");
  switch (network) {
    case "tcp":
    case "raw": {
      const header = parameter("headerType");
      if (header && header !== "none" && header !== "http") return;
      if (header === "http") {
        streamSettings.rawSettings = {
          header: {
            type: "http",
            request: {
              path: path?.split(","),
              headers: transportHost ? { Host: transportHost.split(",") } : undefined,
            },
          },
        };
      }
      break;
    }
    case "ws":
      streamSettings.wsSettings = { host: transportHost, path };
      break;
    case "grpc":
      streamSettings.grpcSettings = {
        serviceName: parameter("serviceName"),
        authority: parameter("authority"),
        multiMode: parameter("mode") === "multi",
      };
      break;
    case "httpupgrade":
      streamSettings.httpupgradeSettings = { host: transportHost, path };
      break;
    case "xhttp":
      streamSettings.xhttpSettings = {
        host: transportHost,
        path,
        mode: parameter("mode"),
        extra: parameter("extra") ? JSON.parse(parameter("extra")!) : undefined,
      };
      break;
    default:
      return;
  }

  const serverName = parameter("sni");
  const fingerprint = parameter("fp") ?? "chrome";
  if (security === "tls") {
    streamSettings.tlsSettings = {
      serverName,
      fingerprint,
      alpn: parameter("alpn")?.split(","),
      echConfigList: parameter("ech"),
    };
  } else if (security === "reality") {
    const publicKey = parameter("pbk");
    if (!publicKey) return;
    streamSettings.realitySettings = {
      serverName: serverName ?? host,
      fingerprint,
      publicKey,
      shortId: parameter("sid"),
      spiderX: parameter("spx"),
      mldsa65Verify: parameter("pqv"),
    };
  } else if (security !== "none") {
    return;
  }

  return makeNode(decodeURIComponent(uri.hash.slice(1)) || host, "subscription", {
    protocol: "vless",
    settings: {
      vnext: [{
        address: host,
        port: Number(uri.port),
        users: [{
          id: decodeURIComponent(uri.username),
          encryption: parameter("encryption") ?? "none",
          flow: parameter("flow"),
        }],
      }],
    },
    streamSettings,
  });
}

export function readSubscription(body: string) {
  const trimmed = body.trim();
  const compact = trimmed.replace(/\s/g, "");
  const text = /^[A-Za-z0-9+/_-]+=*$/.test(compact)
    ? Buffer.from(compact, "base64").toString("utf8")
    : trimmed;
  const nodes = new Map<string, ProxyNode>();
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const link = line.trim();
    if (!link || link.startsWith("#")) continue;
    let node: ProxyNode | undefined;
    try {
      node = parseVlessLink(link);
    } catch {
      // A malformed entry does not prevent importing the rest of the subscription.
    }
    if (node) nodes.set(node.id, node);
    else skipped++;
  }
  return { nodes: [...nodes.values()], skipped };
}
