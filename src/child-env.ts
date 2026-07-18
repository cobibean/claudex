const ALLOWED_PROXY_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "BROWSER",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
]);

export function buildProxyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (ALLOWED_PROXY_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))) {
      child[key] = value;
    }
  }
  return child;
}
