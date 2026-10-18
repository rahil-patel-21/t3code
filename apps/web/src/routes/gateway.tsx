import { createFileRoute, redirect } from "@tanstack/react-router";

import { ApiGatewayPage } from "../components/apiGateway/ApiGatewayPage";

// Not `/api-gateway`: the dev server proxies every path that starts with
// `/api` to the backend, so a reload of that URL would never reach the app.
export const Route = createFileRoute("/gateway")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ApiGatewayPage,
});
