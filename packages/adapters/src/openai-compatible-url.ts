import { isIP } from "node:net";

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "169.254.169.254"]);

export function openAiCompatAllowPublicHosts(): boolean {
  return process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC === "1";
}

export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }
  let path = url.pathname.replace(/\/+$/, "") || "";
  if (!path.endsWith("/v1")) {
    path = path ? `${path}/v1` : "/v1";
  }
  return `${url.origin}${path}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "host.docker.internal"
  ) {
    return true;
  }
  if (METADATA_HOSTS.has(normalized)) return false;
  const ipKind = isIP(normalized);
  if (ipKind === 4 || ipKind === 6) return isPrivateAddress(normalized);
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return METADATA_HOSTS.has(normalized);
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : undefined);
  if (!ipv4) {
    const ipv6 = parseIpv6(value);
    if (ipv6 === undefined) return true;
    if (ipv6 === 0n || ipv6 === 1n) return true;
    if (ipv6 >> 120n === 0xffn) return true;
    const topTenBits = ipv6 >> 118n;
    if (topTenBits === 0x3fan || topTenBits === 0x3fbn) return true;
    if (((ipv6 >> 120n) & 0xfen) === 0xfcn) return true;
    if (ipv6 >> 32n === 0xffffn) return isPrivateIpv4Number(Number(ipv6 & 0xffffffffn));
    if (ipv6 >> 32n === 0n) return true;
    return false;
  }
  const octets = ipv4.split(".").map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b != null && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b != null && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a != null && a >= 224)
  );
}

function parseIpv6(value: string): bigint | undefined {
  if (isIP(value) !== 6) return undefined;
  const [leftValue, rightValue] = value.split("::", 2);
  const left = leftValue ? leftValue.split(":") : [];
  const right = rightValue ? rightValue.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (!value.includes("::") && missing !== 0) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return undefined;
  try {
    return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group || "0"}`), 0n);
  } catch {
    return undefined;
  }
}

function isPrivateIpv4Number(value: number): boolean {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function assertAllowedOpenAiCompatibleUrl(
  raw: string,
  opts?: { allowPublic?: boolean },
): URL {
  const normalized = normalizeOpenAiCompatibleBaseUrl(raw);
  const url = new URL(normalized);
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("Base URL targets a blocked metadata host");
  }
  const allowPublic = opts?.allowPublic ?? openAiCompatAllowPublicHosts();
  if (isPrivateHostname(hostname)) return url;
  if (!allowPublic) {
    throw new Error(
      "Public model endpoints are blocked. Set RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=1 to allow them.",
    );
  }
  return url;
}
