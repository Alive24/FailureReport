import { defineChannel, GET } from "eve/channels";
import {
  localDev,
  placeholderAuth,
  routeAuth,
  vercelOidc,
} from "eve/channels/auth";

import {
  RuntimeTargetBindingError,
  readRuntimeTargetBinding,
} from "../lib/runtime-target-binding.js";

const runtimeAuth = [vercelOidc(), localDev(), placeholderAuth()];

/**
 * Authenticated readiness proof used by outer runtime supervisors.
 * The response intentionally excludes host paths, process ids, and credentials.
 */
export function runtimeBindingResponse(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Response {
  const instanceId = environment.FAILURE_REPORT_RUNTIME_INSTANCE_ID?.trim();
  let target;
  try {
    target = readRuntimeTargetBinding(environment);
  } catch (error) {
    if (!(error instanceof RuntimeTargetBindingError)) {
      throw error;
    }
    return Response.json(
      {
        schema_version: "failure-report/runtime-binding/v1",
        status: "not_ready",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (!instanceId || !/^[a-zA-Z0-9._:-]+$/.test(instanceId)) {
    return Response.json(
      {
        schema_version: "failure-report/runtime-binding/v1",
        status: "not_ready",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    {
      schema_version: "failure-report/runtime-binding/v1",
      status: "ready",
      repository: target.repository,
      revision: target.revision,
      instance_id: instanceId,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export default defineChannel({
  routes: [
    GET("/failure-report/v1/runtime", async (request) => {
      const authorization = await routeAuth(request, runtimeAuth);
      if (authorization instanceof Response) {
        return authorization;
      }
      return runtimeBindingResponse();
    }),
  ],
});
