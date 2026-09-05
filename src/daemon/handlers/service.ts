import { parsePublicServiceStatus } from "../../contracts.js";
import { serviceStatus } from "../../service-management.js";
import type { DaemonContext } from "../context.js";
import type { RouteResponse } from "../router.js";

type ServiceContext = Pick<DaemonContext, "layout">;

/** Cache only public observations; concurrent UI polls never launch duplicate probes. */
export function createServiceStatusHandler(discover: typeof serviceStatus = serviceStatus) {
  const observations = new WeakMap<
    ServiceContext,
    { until: number; result: Promise<RouteResponse> }
  >();
  return (ctx: ServiceContext): Promise<RouteResponse> => {
    const cached = observations.get(ctx);
    if (cached && cached.until > Date.now()) return cached.result;
    const result = discover(ctx.layout).then(
      (status): RouteResponse => ({
        status: 200,
        json: parsePublicServiceStatus(status),
      }),
    );
    observations.set(ctx, { until: Date.now() + 5000, result });
    return result;
  };
}

export const readServiceStatus = createServiceStatusHandler();
