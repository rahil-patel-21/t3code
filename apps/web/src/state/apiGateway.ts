import { createApiGatewayEnvironmentAtoms } from "@t3tools/client-runtime/state/api-gateway";

import { connectionAtomRuntime } from "../connection/runtime";

export const apiGatewayEnvironment = createApiGatewayEnvironmentAtoms(connectionAtomRuntime);
