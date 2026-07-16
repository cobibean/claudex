function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(input: string, extraSecrets: readonly string[] = []): string {
  let output = input;
  for (const secret of extraSecrets) {
    if (secret) output = output.replaceAll(secret, "[REDACTED]");
  }

  output = output.replace(
    /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi,
    "$1[REDACTED]"
  );
  output = output.replace(
    /("?(?:access_token|refresh_token|id_token|device_code|client_secret|code_verifier)"?\s*[:=]\s*")([^"]+)(")/gi,
    "$1[REDACTED]$3"
  );
  output = output.replace(
    /([?&](?:code|state|device_code|code_verifier)=)[^&\s]+/gi,
    "$1[REDACTED]"
  );

  for (const label of ["access_token", "refresh_token", "id_token", "device_code", "client_secret"]) {
    const pattern = new RegExp(`(${escapeRegExp(label)}\\s*[:=]\\s*)([^\\s,]+)`, "gi");
    output = output.replace(pattern, "$1[REDACTED]");
  }
  return output;
}
