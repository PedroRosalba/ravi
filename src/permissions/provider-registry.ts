import { contextCapabilitiesProvider } from "./context-capabilities-provider.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";
import { agentIdentityPermissionsProvider } from "./agent-identity-permissions-provider.js";
import { agentDefaultCapabilitiesProvider } from "./agent-default-capabilities-provider.js";
import { contactPolicyPermissionsProvider } from "./contact-policy-permissions-provider.js";
import { externalAuthorityProvider } from "./external-authority-provider.js";
import { operatorControlProvider } from "./operator-control-provider.js";
import { runtimeBootstrapProvider } from "./runtime-bootstrap-provider.js";

export const localOperatorProvider: PermissionProvider = operatorControlProvider;

/**
 * Registro de providers de autorização endereçáveis por id.
 *
 * A cadeia passa a ser escolhida por configuração (`RAVI_PERMISSION_PROVIDER_IDS`),
 * em vez de constante — é o ponto que faltava para plugar uma autoridade
 * EXTERNA (on-chain, serviço, MCP) sem editar o runtime.
 */
const PROVIDER_REGISTRY: Record<string, () => PermissionProvider> = {
  "operator-control": () => operatorControlProvider,
  "context-capabilities": () => contextCapabilitiesProvider,
  "external-authority": () => externalAuthorityProvider,
};

export const DEFAULT_PERMISSION_PROVIDER_IDS = ["operator-control", "context-capabilities"] as const;

export const EXTERNAL_AUTHORITY_PROVIDER_IDS = ["external-authority"] as const;

/**
 * Provider que representa uma configuração inválida.
 *
 * Fail-closed: se o operador configura um id que não existe (ou indisponível
 * neste build), a decisão é NEGAR com causa explícita. Silenciar e voltar ao
 * default seria fail-open — autoridade pedida não é autoridade concedida.
 */
function unavailableProvider(missingId: string): PermissionProvider {
  return {
    id: `unavailable:${missingId}`,
    version: "0",
    required: true,
    supports: () => true,
    authorize(request: PermissionProviderRequest): PermissionProviderDecision {
      return {
        decision: "deny",
        allowed: false,
        providerId: `unavailable:${missingId}`,
        providerVersion: "0",
        reasonCode: "permission_provider_unavailable",
        permission: request.permission,
        objectType: request.objectType,
        objectId: request.objectId,
        ...(request.subject ? { subject: request.subject } : {}),
        evidence: [{ kind: "config", missingProviderId: missingId, available: Object.keys(PROVIDER_REGISTRY) }],
      };
    },
    materializeCapabilities: () => [],
  };
}

export function parsePermissionProviderIds(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function getConfiguredPermissionProviders(env: NodeJS.ProcessEnv = process.env): PermissionProvider[] {
  const configured = parsePermissionProviderIds(env.RAVI_PERMISSION_PROVIDER_IDS);
  const ids = configured.length > 0 ? configured : [...DEFAULT_PERMISSION_PROVIDER_IDS];
  return ids.map((id) => PROVIDER_REGISTRY[id]?.() ?? unavailableProvider(id));
}

export function listRegisteredPermissionProviderIds(): string[] {
  return Object.keys(PROVIDER_REGISTRY);
}

const DEFAULT_CAPABILITY_MATERIALIZERS: PermissionProvider[] = [
  runtimeBootstrapProvider,
  agentDefaultCapabilitiesProvider,
  agentIdentityPermissionsProvider,
  contactPolicyPermissionsProvider,
];

export function getConfiguredCapabilityMaterializers(): PermissionProvider[] {
  return DEFAULT_CAPABILITY_MATERIALIZERS;
}
