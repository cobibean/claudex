export interface ProxyConfigInput {
  authDir: string;
  apiKey: string;
  port: number;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderProxyConfig(input: ProxyConfigInput): string {
  return `host: "127.0.0.1"
port: ${input.port}

tls:
  enable: false
  cert: ""
  key: ""

remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
  disable-auto-update-panel: true

auth-dir: ${yamlString(input.authDir)}

api-keys:
  - ${yamlString(input.apiKey)}

debug: false
commercial-mode: false
logging-to-file: false
request-log: false
usage-statistics-enabled: false
force-model-prefix: false
passthrough-headers: false
ws-auth: true

pprof:
  enable: false
  addr: "127.0.0.1:8316"

plugins:
  enabled: false
  dir: "plugins"
  configs: {}

streaming:
  keepalive-seconds: 15
  bootstrap-retries: 1

codex:
  identity-confuse: false
`;
}
